// The three v1 tool definitions, as pure factories over (config, vision
// client, visual working memory). The flow is user-image-first: the user
// uploads an image or gives a path, and these tools turn it into what the
// text-only main model needs — a numbered inventory (map), answers and
// verbatim text (read), and targeted crops (zoom).

import { existsSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { drawBoxes } from './annotate.js'
import { parseElements, parseRegion, positionLabel } from './bbox.js'
import { normToPx, pxToNormOfOriginal } from './coords.js'
import { regionFor } from './crop.js'
import { imageDiff } from './diff.js'
import { decodeImage, readImageInfo } from './image.js'
import { encodePng } from './png.js'
import { readImageDims, prepareUpload, prepareCropUpload, ImageError } from './preprocess.js'
import { checkPrompt, mapPrompt, readAskPrompt, readStripPrompt, readTranscribePrompt, zoomPrompt } from './prompts.js'
import { VisualMemory, RegistryError } from './registry.js'
import { mergeStrips, planStrips, shouldTile, unreadableStrip } from './tile.js'
import { callVision, VisionError, type VisionConfig } from './vision-client.js'

export interface ToolDeps {
  vision: VisionConfig
  memory: VisualMemory
  maxEdge: number
}

const text = (value: string): ContentBlock[] => [{ type: 'text', text: value }]

function errorText(error: unknown): string {
  if (error instanceof VisionError || error instanceof ImageError || error instanceof RegistryError || error instanceof Error) {
    return error.message
  }
  return String(error)
}

const VERDICT_VALUES = ['supported', 'contradicted', 'unverifiable'] as const

/** Content-addressed DSH attachment cache: no annotation siblings there. */
const ATTACHMENT_CACHE = /[\\/]\.dsh[\\/]attachments[\\/]/

export interface Verdict {
  claim: string
  verdict: 'supported' | 'contradicted' | 'unverifiable'
  reason: string
}

/** Tolerant parse of the vision_check verdict reply (fences, wrapper keys). */
export function parseVerdicts(text: string, claims: string[]): Verdict[] {
  const cleaned = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '').trim()
  let items: unknown[] | null = null
  let structured = false
  try {
    const payload: unknown = JSON.parse(cleaned)
    structured = true
    if (Array.isArray(payload)) items = payload
    else if (payload !== null && typeof payload === 'object') {
      const record = payload as Record<string, unknown>
      if (Array.isArray(record.verdicts)) items = record.verdicts
    }
  } catch {
    // fall through to the tolerant pickups below
  }
  if (items === null) {
    // Regex fallback: {claim|verdict|reason} objects, quoted or not.
    items = []
    const pattern = /\{[^{}]*["']?(?:claim|verdict|reason)["']?[^{}]*\}/g
    for (const block of cleaned.matchAll(pattern)) {
      structured = true
      const chunk = block[0]
      const pick = (key: string): string => {
        const match = chunk.match(new RegExp(`["']?${key}["']?\\s*:\\s*["']([^"']+)["']`))
        return match?.[1] ?? ''
      }
      items.push({ claim: pick('claim'), verdict: pick('verdict'), reason: pick('reason') })
    }
  }
  if (!structured) {
    throw new Error('vision API did not return a parseable verdict list')
  }
  const verdicts: Verdict[] = []
  for (const item of items) {
    if (item === null || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const rawVerdict = typeof record.verdict === 'string' ? record.verdict.toLowerCase() : ''
    if (!VERDICT_VALUES.includes(rawVerdict as (typeof VERDICT_VALUES)[number])) continue
    // A verdict must carry its own claim. Never bind positionally: a verdict
    // without a claim would otherwise confirm a claim the model never
    // evaluated — the worst failure mode for a verification tool.
    const claim = typeof record.claim === 'string' ? record.claim.trim() : ''
    if (!claim) continue
    const reason = typeof record.reason === 'string' ? record.reason.trim() : ''
    verdicts.push({ claim, verdict: rawVerdict as Verdict['verdict'], reason })
  }
  // Claims the model never addressed become honest "unverifiable" rows. When
  // the reply parsed structurally but every row was dropped (missing claim or
  // invalid verdict), everything lands as unverifiable — never a false
  // confirmation. Only an entirely unparseable reply throws.
  const seen = new Set(verdicts.map((verdict) => verdict.claim))
  for (const claim of claims) {
    if (!seen.has(claim)) verdicts.push({ claim, verdict: 'unverifiable', reason: 'the vision model did not address this claim' })
  }
  return verdicts
}

/** Generic object output schema with exactly the given properties. */
// Schemas are inlined at each tool call site so the const generic inference
// captures literal types (a helper typed as Record<string, unknown> breaks
// execute-return checking).

export function buildTools(deps: ToolDeps): ToolDefinition[] {
  const { vision, memory, maxEdge } = deps

  // ── vision_map: numbered element inventory (the signature tool) ─────────
  const map = defineTool({
    name: 'vision_map',
    description:
      'Annotate an image into a numbered inventory: every distinct interactive or informative element (buttons, inputs, icons, headings, banners) gets an id, a label, its verbatim visible text, a confidence score, and its pixel box, and the list is kept in visual working memory. Map first: before reasoning about what an image contains or where something is, map it, then refer to elements by id ("element 7"), never by vague description. Boxes and text let you reason spatially and read elements without extra vision calls; use vision_zoom when a detail is still not legible. Optionally filter with `focus` (one kind only), or annotate only inside `region`. Boxes are not pixel-exact (model grid scaled to the image) — accurate enough to crop or zoom. A different file means a new map: ids never carry over between images.',
    parameters: {
      image: { type: 'string', required: true, description: 'Absolute image path: PNG, JPEG, GIF, WebP or BMP. The format is sniffed from the bytes, so a file with no extension (a DSH attachment cache object, for example) is fine.' },
      focus: { type: 'string', description: 'Optional element kind to list only, e.g. "buttons" or "error messages".' },
      region: { type: 'string', description: 'Optional pixel box "X1,Y1,X2,Y2" to annotate only inside (PNG/JPEG/GIF/BMP; WebP cannot be cropped locally). Results stay in original-image coordinates.' },
      maxItems: { type: 'integer', description: 'Maximum elements to list (default 30).' },
      annotate: { type: 'boolean', description: 'Also write <stem>.annotated.png with the boxes drawn on the image (default true; any decodable format).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          imageId: { type: 'string' },
          width: { type: 'integer' },
          height: { type: 'integer' },
          annotatedPath: { type: 'string' },
          elements: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'integer' },
                label: { type: 'string' },
                text: { type: 'string' },
                confidence: { type: 'number' },
                position: { type: 'string' },
                x1: { type: 'integer' },
                y1: { type: 'integer' },
                x2: { type: 'integer' },
                y2: { type: 'integer' },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const result = value as {
          imageId: string
          annotatedPath: string
          width: number
          height: number
          elements: Array<{ id: number; label: string; text?: string; confidence?: number; position: string; x1: number; y1: number; x2: number; y2: number }>
        }
        const lines = result.elements.map((element) => {
          const quote = element.text ? ` "${element.text}"` : ''
          const confidence = element.confidence !== undefined ? ` (conf ${element.confidence.toFixed(2)})` : ''
          return `${element.id}. [${element.position}] ${element.label}${quote}${confidence}  x1: ${element.x1}, y1: ${element.y1}, x2: ${element.x2}, y2: ${element.y2}`
        })
        if (lines.length === 0) lines.push('no elements detected')
        lines.push(`visual memory updated: refs 1-${result.elements.length} valid for ${result.imageId} — use vision_zoom ref "N" to inspect one element.`)
        if (result.annotatedPath) lines.push(`annotated proof: ${result.annotatedPath}`)
        return text(lines.join('\n'))
      },
    },
    // NOTE: no isConcurrencySafe here — vision_map writes the shared registry,
    // so concurrent maps of the same image would race (last-wins) and stale
    // ids could leak into vision_zoom. It stays exclusive by default.
    async execute(args, exec) {
      try {
        const originalDims = readImageDims(args.image)
        const maxItems = args.maxItems ?? 30
        let prepared
        if (args.region) {
          prepared = prepareCropUpload(args.image, parseRegion(args.region, originalDims.width, originalDims.height), { maxEdge })
        } else {
          prepared = prepareUpload(args.image, maxEdge)
        }
        const answer = await callVision(vision, {
          task: 'map',
          signal: exec.signal,
          prompt: mapPrompt({ focus: args.focus, maxItems, lang: vision.lang }),
          images: [{ dataUrl: prepared.dataUrl }],
          jsonMode: true,
        })
        const parsed = parseElements(answer, maxItems, prepared.view.viewDims)
        const imageId = basename(args.image)
        const regions = parsed.map((element) => ({
          id: element.id,
          label: element.label,
          ...(element.text !== undefined ? { text: element.text } : {}),
          ...(element.confidence !== undefined ? { confidence: element.confidence } : {}),
          norm: pxToNormOfOriginal(normToPx(element.norm, prepared.view), originalDims),
        }))
        memory.store(args.image, imageId, originalDims.width, originalDims.height, regions)
        const elements = parsed.map((element) => {
          const box = normToPx(element.norm, prepared.view)
          return {
            id: element.id,
            label: element.label,
            text: element.text ?? '',
            confidence: element.confidence ?? 0,
            position: positionLabel(box, originalDims.width, originalDims.height),
            x1: box.x1,
            y1: box.y1,
            x2: box.x2,
            y2: box.y2,
          }
        })
        // Annotated proof: draw the boxes on the original pixels. Never
        // overwrites an existing file — the proof belongs to the map that
        // first wrote it. Content-addressed attachment cache objects are
        // skipped: their name is a hash and the directory is a cache, so a
        // sibling proof would only accumulate garbage.
        let annotatedPath = ''
        if (args.annotate !== false && !ATTACHMENT_CACHE.test(args.image)) {
          try {
            const info = readImageInfo(args.image)
            if (info.decodable) {
              const stem = basename(args.image).replace(/\.[^.]*$/, '') || basename(args.image)
              const candidate = join(dirname(args.image), `${stem}.annotated.png`)
              const original = decodeImage(info.bytes, info.format)
              const drawn = drawBoxes(original, elements.map((element) => ({ x1: element.x1, y1: element.y1, x2: element.x2, y2: element.y2 })))
              if (!existsSync(candidate)) writeFileSync(candidate, encodePng(drawn))
              annotatedPath = candidate
            }
          } catch {
            annotatedPath = '' // annotation is best-effort; the inventory stands
          }
        }
        return { imageId, width: originalDims.width, height: originalDims.height, annotatedPath, elements }
      } catch (error) {
        throw new Error(errorText(error))
      }
    },
  })

  // ── vision_read: Q&A + verbatim text extraction ─────────────────────────
  const read = defineTool({
    name: 'vision_read',
    description:
      'Read images with a vision model. mode "transcribe" extracts ALL visible text verbatim, character for character — the mode for receipts, logs, forms, long chat screenshots; tall pages are automatically cut into overlapping top-to-bottom strips and merged, so a long page is read at full detail, not shrunk. mode "ask" answers a precise question; pass several image paths at once to compare them in one call — never compare via separate calls. The model is instructed not to guess: if a needed detail is not legible, it says which region to inspect (INSPECT hint) instead of inventing it.',
    parameters: {
      images: { type: 'array', items: { type: 'string' }, required: true, description: 'One or more absolute image paths.' },
      mode: { type: 'string', required: true, enum: ['ask', 'transcribe'], description: '"ask" answers a question; "transcribe" extracts all visible text verbatim.' },
      question: { type: 'string', description: 'The exact question; required when mode is "ask", forbidden when "transcribe".' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          mode: { type: 'string' },
          answer: { type: 'string' },
          images: { type: 'integer' },
          tiled: { type: 'boolean' },
          strips: { type: 'integer' },
        },
      },
      render: (_args, value) => {
        const result = value as { answer: string; tiled: boolean; strips: number }
        return text(result.tiled ? `${result.answer}\n(transcribed from ${result.strips} overlapping strips, merged top-to-bottom)` : result.answer)
      },
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      try {
        if (args.mode === 'ask') {
          if (!args.question) throw new Error('vision_read mode "ask" requires a question')
          const prepared = args.images.map((path) => prepareUpload(path, maxEdge))
          const answer = await callVision(vision, {
            task: 'read',
            signal: exec.signal,
            prompt: readAskPrompt(args.question, args.images.length, vision.lang),
            images: prepared.map((upload) => ({ dataUrl: upload.dataUrl })),
            maxTokens: 4096,
          })
          return { mode: 'ask', answer, images: args.images.length, tiled: false, strips: 1 }
        }
        // transcribe
        if (args.question) throw new Error('vision_read mode "transcribe" does not take a question')
        const answers: string[] = []
        let totalStrips = 0
        let anyTiled = false
        for (const path of args.images) {
          const dims = readImageDims(path)
          if (shouldTile(dims)) {
            anyTiled = true
            const plan = planStrips(dims.width, dims.height)
            const parts: string[] = []
            for (const strip of plan.strips) {
              totalStrips++
              try {
                const prepared = prepareCropUpload(path, { x1: 0, y1: strip.y1, x2: dims.width, y2: strip.y2 }, { maxEdge })
                const part = await callVision(vision, {
                  task: 'read',
                  signal: exec.signal,
                  prompt: readStripPrompt(strip.index, strip.count),
                  images: [{ dataUrl: prepared.dataUrl }],
                  maxTokens: 2048,
                  deterministic: true,
                })
                parts.push(part)
              } catch (error) {
                parts.push(unreadableStrip(strip.index))
                void error
              }
            }
            answers.push(mergeStrips(parts))
          } else {
            totalStrips++
            const prepared = prepareUpload(path, maxEdge)
            const answer = await callVision(vision, {
              task: 'read',
              signal: exec.signal,
              prompt: readTranscribePrompt(),
              images: [{ dataUrl: prepared.dataUrl }],
              maxTokens: 4096,
              deterministic: true,
            })
            answers.push(answer)
          }
        }
        const answer = answers.length > 1 ? answers.map((part, index) => `## Image ${index + 1}\n${part}`).join('\n\n') : (answers[0] ?? '')
        return { mode: 'transcribe', answer, images: args.images.length, tiled: anyTiled, strips: totalStrips }
      } catch (error) {
        throw new Error(errorText(error))
      }
    },
  })

  // ── vision_zoom: targeted region inspection (coarse-to-fine) ────────────
  const zoom = defineTool({
    name: 'vision_zoom',
    description:
      'Zoom into one region of an image and answer a targeted question about it. The crop is uploaded alone, so small text, icons, and states are read at effectively full resolution — a full-image pass routinely misses them. Prefer `ref` (an id from vision_map\'s visual working memory, e.g. "7") over a raw `region` box. `scale` upscales the crop for tiny elements. Zoom is the only reliable way to inspect one element closely; if the crop is still not enough, the answer will say exactly what is missing instead of guessing.',
    parameters: {
      image: { type: 'string', required: true, description: 'Absolute image path: PNG, JPEG, GIF or BMP (format sniffed from the bytes; the extension does not matter). WebP can be read but not cropped locally.' },
      question: { type: 'string', required: true, description: 'The targeted question, e.g. "is this button enabled or greyed out?" or "what is the exact error text?".' },
      ref: { type: 'string', description: 'Element id from vision_map ("7", or "7@imageId"). Mutually exclusive with region.' },
      region: { type: 'string', description: 'Alternative raw pixel box "X1,Y1,X2,Y2" when no registry entry exists.' },
      scale: { type: 'integer', description: 'Optional integer upscale of the crop, 2-8, for tiny elements.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          answer: { type: 'string' },
          box: {
            type: 'object',
            additionalProperties: false,
            properties: {
              x1: { type: 'integer' },
              y1: { type: 'integer' },
              x2: { type: 'integer' },
              y2: { type: 'integer' },
            },
          },
          cropWidth: { type: 'integer' },
          cropHeight: { type: 'integer' },
          scale: { type: 'integer' },
        },
      },
      render: (_args, value) => {
        const result = value as { answer: string; box: { x1: number; y1: number; x2: number; y2: number } }
        return text(`${result.answer}\n(crop box: x1: ${result.box.x1}, y1: ${result.box.y1}, x2: ${result.box.x2}, y2: ${result.box.y2})`)
      },
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      try {
        const scale = args.scale ?? 1
        if (!Number.isInteger(scale) || scale < 1 || scale > 8) throw new Error('scale must be an integer between 1 and 8')
        let box: { x1: number; y1: number; x2: number; y2: number }
        if (args.ref && args.region) throw new Error('ref and region are mutually exclusive — pass exactly one')
        if (args.ref) {
          box = memory.resolve(args.image, args.ref).box
        } else if (args.region) {
          const region = regionFor(args.image, args.region)
          if (!region) throw new Error('region is required when ref is not given')
          box = region
        } else {
          throw new Error('pass either ref (a vision_map id) or region (a "X1,Y1,X2,Y2" box)')
        }
        const prepared = prepareCropUpload(args.image, box, { scale, maxEdge })
        const answer = await callVision(vision, {
          task: 'zoom',
          signal: exec.signal,
          prompt: zoomPrompt(args.question, vision.lang),
          images: [{ dataUrl: prepared.dataUrl }],
          maxTokens: 4096,
        })
        return { answer, box, cropWidth: prepared.view.viewDims.width, cropHeight: prepared.view.viewDims.height, scale }
      } catch (error) {
        throw new Error(errorText(error))
      }
    },
  })

  // ── vision_check: claim verification (Woodpecker-lite) ──────────────────
  const check = defineTool({
    name: 'vision_check',
    description:
      'Verify plain-language claims against visual evidence in one image. Each claim gets a verdict: "supported" (directly visible), "contradicted" (the image shows the opposite), or "unverifiable" (too small, cut off, or outside the image). Use it before asserting visual facts you have not confirmed yourself — the vision model is instructed to prefer "unverifiable" over guessing.',
    parameters: {
      image: { type: 'string', required: true, description: 'Absolute image path.' },
      claims: { type: 'array', items: { type: 'string' }, required: true, description: 'Plain sentences to verify, e.g. "the page shows a 404 error", "the button is red".' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          verdicts: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                claim: { type: 'string' },
                verdict: { type: 'string' },
                reason: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const result = value as { verdicts: Verdict[] }
        return text(result.verdicts.map((verdict) => `${verdict.verdict}: ${verdict.claim}${verdict.reason ? ` — ${verdict.reason}` : ''}`).join('\n'))
      },
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      try {
        const prepared = prepareUpload(args.image, maxEdge)
        const answer = await callVision(vision, {
          task: 'check',
          signal: exec.signal,
          prompt: checkPrompt(args.claims),
          images: [{ dataUrl: prepared.dataUrl }],
          jsonMode: true,
        })
        return { verdicts: parseVerdicts(answer, args.claims) }
      } catch (error) {
        throw new Error(errorText(error))
      }
    },
  })

  // ── vision_diff: reference-vs-implementation pixel diff ─────────────────
  const diff = defineTool({
    name: 'vision_diff',
    description:
      'Diff two PNG images pixel by pixel (local, deterministic — no vision API) and return the overall difference percentage plus the worst differing regions as boxes. The iteration tool: after changing a page or UI, diff the new screenshot against the reference to measure how close it is, then zoom into the worst regions. A small badge or shifted pixel is a rounding error to a vision model and exact to this tool — diff first to get the boxes, then vision_read/vision_zoom those boxes to read what the change actually is.',
    parameters: {
      a: { type: 'string', required: true, description: 'Absolute PNG path of the first image (e.g. the reference).' },
      b: { type: 'string', required: true, description: 'Absolute PNG path of the second image (e.g. the current screenshot).' },
      tolerance: { type: 'integer', description: 'Per-channel difference that counts a pixel as changed (default 8).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          percent: { type: 'number' },
          changedPixels: { type: 'integer' },
          totalPixels: { type: 'integer' },
          overlapOnly: { type: 'boolean' },
          regions: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                x1: { type: 'integer' },
                y1: { type: 'integer' },
                x2: { type: 'integer' },
                y2: { type: 'integer' },
                changed: { type: 'integer' },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const result = value as { percent: number; changedPixels: number; totalPixels: number; overlapOnly: boolean; regions: Array<{ x1: number; y1: number; x2: number; y2: number; changed: number }> }
        const lines = [
          `${result.percent.toFixed(2)}% pixels differ (${result.changedPixels} of ${result.totalPixels})${result.overlapOnly ? ' — sizes differed, compared the overlapping region' : ''}`,
          ...result.regions.map((region) => `worst region x1: ${region.x1}, y1: ${region.y1}, x2: ${region.x2}, y2: ${region.y2} (${region.changed} changed pixels)`),
        ]
        return text(lines.join('\n'))
      },
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      try {
        const result = imageDiff(args.a, args.b, Math.max(0, args.tolerance ?? 8))
        return {
          percent: result.percent,
          changedPixels: result.changedPixels,
          totalPixels: result.totalPixels,
          overlapOnly: result.overlapOnly,
          regions: result.blocks.map((block) => ({ x1: block.x1, y1: block.y1, x2: block.x2, y2: block.y2, changed: block.changed })),
        }
      } catch (error) {
        throw new Error(errorText(error))
      }
    },
  })

  return [map, read, zoom, check, diff]
}
