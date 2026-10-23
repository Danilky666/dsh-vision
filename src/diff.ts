// Deterministic pixel diff with block-level aggregation. The substrate for
// reference-vs-implementation iteration verdicts ("6.04% -> 0%") and, later,
// surprise-gated re-mapping and screencast keyframes. Zero API cost, zero
// dependencies — both images decode through the bundled codecs, so a PNG can be
// compared against a JPEG screenshot without converting anything first.

import type { PngImage } from './png.js'
import { decodeImage, readImageInfo, ImageError } from './image.js'

export class DiffError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DiffError'
  }
}

export interface DiffBlock {
  x1: number
  y1: number
  x2: number
  y2: number
  changed: number
}

export interface BlockDiffResult {
  percent: number
  changedPixels: number
  totalPixels: number
  /** Top differing blocks (box + changed-pixel count), most changed first. */
  blocks: DiffBlock[]
  /** True when the images had different sizes and only the overlap was compared. */
  overlapOnly: boolean
}

/**
 * Compare two RGBA images pixel by pixel (per-channel tolerance), aggregate
 * per block, and return the top blocks. Same dimensions required — callers
 * handle size mismatch (see imageDiff).
 */
export function blockDiff(a: PngImage, b: PngImage, tolerance = 8, blockSize = 16): BlockDiffResult {
  if (a.width !== b.width || a.height !== b.height) {
    throw new DiffError(`image sizes differ: ${a.width}x${a.height} vs ${b.width}x${b.height}`)
  }
  const width = a.width
  const height = a.height
  let changedPixels = 0
  const blockCounts = new Map<number, number>()
  const blockW = Math.max(1, Math.ceil(width / blockSize))
  const blockKey = (bx: number, by: number) => by * blockW + bx
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      const dr = Math.abs(a.data[i] - b.data[i])
      const dg = Math.abs(a.data[i + 1] - b.data[i + 1])
      const db = Math.abs(a.data[i + 2] - b.data[i + 2])
      const da = Math.abs(a.data[i + 3] - b.data[i + 3])
      if (Math.max(dr, dg, db, da) > tolerance) {
        changedPixels++
        const key = blockKey(Math.floor(x / blockSize), Math.floor(y / blockSize))
        blockCounts.set(key, (blockCounts.get(key) ?? 0) + 1)
      }
    }
  }
  const blocks = [...blockCounts.entries()]
    .sort((p, q) => q[1] - p[1])
    .slice(0, 5)
    .map(([key, count]) => {
      const bx = key % blockW
      const by = Math.floor(key / blockW)
      return {
        x1: bx * blockSize,
        y1: by * blockSize,
        x2: Math.min(width, (bx + 1) * blockSize),
        y2: Math.min(height, (by + 1) * blockSize),
        changed: count,
      }
    })
  return { percent: (changedPixels / (width * height)) * 100, changedPixels, totalPixels: width * height, blocks, overlapOnly: false }
}

/** Diff two PNG files, comparing the overlapping region when sizes differ. */
export function imageDiff(aPath: string, bPath: string, tolerance = 8): BlockDiffResult {
  const a = requireImage(aPath)
  const b = requireImage(bPath)
  if (a.width !== b.width || a.height !== b.height) {
    // Compare the overlap (top-left aligned) — the honest zero-dep fallback
    // for differing sizes; the caller sees overlapOnly and can re-capture.
    const overlapA: PngImage = {
      width: Math.min(a.width, b.width),
      height: Math.min(a.height, b.height),
      data: new Uint8Array(Math.min(a.width, b.width) * Math.min(a.height, b.height) * 4),
    }
    const overlapB: PngImage = {
      width: overlapA.width,
      height: overlapA.height,
      data: new Uint8Array(overlapA.width * overlapA.height * 4),
    }
    for (let y = 0; y < overlapA.height; y++) {
      const aRow = y * a.width * 4
      const bRow = y * b.width * 4
      const oRow = y * overlapA.width * 4
      overlapA.data.set(a.data.subarray(aRow, aRow + overlapA.width * 4), oRow)
      overlapB.data.set(b.data.subarray(bRow, bRow + overlapA.width * 4), oRow)
    }
    return { ...blockDiff(overlapA, overlapB, tolerance), overlapOnly: true }
  }
  return blockDiff(a, b, tolerance)
}

export function requireImage(path: string): PngImage {
  const info = readImageInfo(path)
  if (!info.decodable) {
    throw new DiffError(`${info.format.toUpperCase()} pixels cannot be decoded locally: convert the file to PNG or JPEG first (${path})`)
  }
  try {
    return decodeImage(info.bytes, info.format)
  } catch (error) {
    if (error instanceof ImageError) throw new DiffError(`${path}: ${error.message}`)
    throw new DiffError(`cannot read image: ${path}`)
  }
}

/** @deprecated Use requireImage: the diff accepts every decodable format. */
export const requirePng = requireImage
