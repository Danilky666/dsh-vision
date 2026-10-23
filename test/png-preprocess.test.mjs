import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, rmSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { encodePng, decodePng } from '../lib/png.js'
import { cropPngRegion } from '../lib/crop.js'
import { meanPoolDownscale, prepareUpload, readImageDims } from '../lib/preprocess.js'

const dir = join(process.cwd(), 'test', 'tmp-preprocess')
mkdirSync(dir, { recursive: true })

function solidPng(width, height, rgba) {
  const data = new Uint8Array(width * height * 4)
  for (let i = 0; i < width * height; i++) data.set(rgba, i * 4)
  return encodePng({ width, height, data })
}

const imagePath = join(dir, 'base.png')

test('PNG roundtrip preserves bytes', () => {
  const original = { width: 8, height: 8, data: new Uint8Array(8 * 8 * 4) }
  for (let i = 0; i < original.data.length; i++) original.data[i] = (i * 37) % 256
  const decoded = decodePng(encodePng(original))
  assert.equal(decoded.width, 8)
  assert.equal(decoded.height, 8)
  assert.deepEqual([...decoded.data], [...original.data])
})

test('cropPngRegion extracts the right pixels', () => {
  const data = new Uint8Array(64 * 64 * 4)
  for (let y = 0; y < 64; y++) {
    for (let x = 0; x < 64; x++) {
      const i = (y * 64 + x) * 4
      data[i] = x
      data[i + 1] = y
      data[i + 2] = 128
      data[i + 3] = 255
    }
  }
  writeFileSync(imagePath, encodePng({ width: 64, height: 64, data }))
  const crop = cropPngRegion(imagePath, { x1: 10, y1: 20, x2: 30, y2: 40 }, null)
  const decoded = decodePng(readFileSync(crop.path))
  assert.equal(decoded.width, 20)
  assert.equal(decoded.height, 20)
  assert.deepEqual([...decoded.data.slice(0, 4)], [10, 20, 128, 255], 'top-left pixel must be (10,20) of the source')
})

test('cropPngRegion upscales with nearest neighbor', () => {
  writeFileSync(imagePath, solidPng(4, 4, [10, 20, 30, 255]))
  const crop = cropPngRegion(imagePath, { x1: 0, y1: 0, x2: 2, y2: 2 }, null, 4)
  const decoded = decodePng(readFileSync(crop.path))
  assert.equal(decoded.width, 8)
  assert.equal(decoded.height, 8)
  assert.deepEqual([...decoded.data.slice(0, 4)], [10, 20, 30, 255])
})

test('meanPoolDownscale averages blocks and shrinks by the factor', () => {
  const image = { width: 4, height: 4, data: new Uint8Array(4 * 4 * 4).fill(100) }
  const down = meanPoolDownscale(image, 2)
  assert.equal(down.width, 2)
  assert.equal(down.height, 2)
  assert.deepEqual([...down.data.slice(0, 4)], [100, 100, 100, 100])
})

test('prepareUpload downscales large PNGs to the long-edge cap', () => {
  writeFileSync(imagePath, solidPng(4096, 100, [5, 6, 7, 255]))
  const prepared = prepareUpload(imagePath, 2048)
  assert.ok(prepared.dataUrl.startsWith('data:image/png;base64,'))
  assert.ok(prepared.view.viewDims.width <= 2048, `view width ${prepared.view.viewDims.width}`)
  assert.equal(prepared.originalDims.width, 4096)
  assert.equal(prepared.view.viewBox.x2, 4096)
})

test('prepareUpload passes small PNGs through untouched', () => {
  writeFileSync(imagePath, solidPng(100, 100, [5, 6, 7, 255]))
  const prepared = prepareUpload(imagePath, 2048)
  assert.equal(prepared.view.viewDims.width, 100)
})

test('readImageDims rejects non-images with a clear error', () => {
  const textPath = join(dir, 'notes.txt')
  writeFileSync(textPath, 'not an image')
  assert.throws(() => readImageDims(textPath), /unrecognized image format/)
  // Format comes from the bytes, so an image with a text extension still works.
  const disguised = join(dir, 'notes.jpg')
  writeFileSync(disguised, solidPng(40, 30, [1, 2, 3, 255]))
  assert.deepEqual(readImageDims(disguised), { width: 40, height: 30 })
})

test('cleanup', () => {
  rmSync(dir, { recursive: true, force: true })
})
