// Format layer regression tests: detection by magic bytes, decoding, and the
// upload/crop paths the vision tools depend on. The fixtures are synthetic
// (a 24x16 gradient plus a checker patch), generated once with sharp and
// System.Drawing — see fixtures.mjs.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { bmp, gif, jpeg, png, progressive, webp } from './fixtures.mjs'
import { decodeImage, readImageInfo, sniffFormat } from '../lib/image.js'
import { decodeJpeg } from '../lib/jpeg.js'
import { decodeGif } from '../lib/gif.js'
import { decodeBmp } from '../lib/bmp.js'
import { prepareCropUpload, prepareUpload } from '../lib/preprocess.js'

const dir = join(process.cwd(), 'test', 'tmp-image')
mkdirSync(dir, { recursive: true })
process.on('exit', () => rmSync(dir, { recursive: true, force: true }))

const bytes = (value) => Buffer.from(value, 'base64')

let counter = 0
function write(name, data) {
  const path = join(dir, `${counter++}-${name}`)
  writeFileSync(path, data)
  return path
}

test('sniffs formats from magic bytes, including extension-less files', () => {
  assert.equal(sniffFormat(bytes(png)), 'png')
  assert.equal(sniffFormat(bytes(jpeg)), 'jpeg')
  assert.equal(sniffFormat(bytes(progressive)), 'jpeg')
  assert.equal(sniffFormat(bytes(gif)), 'gif')
  assert.equal(sniffFormat(bytes(bmp)), 'bmp')
  assert.equal(sniffFormat(bytes(webp)), 'webp')
  assert.equal(sniffFormat(Buffer.from('not an image at all')), null)
})

test('reads a DSH attachment-style path with no extension', () => {
  const path = write('7c6667b4651cadcf0962dd179907255a9b8fe2c1d1f739229ce9cab63dff962d', bytes(jpeg))
  const info = readImageInfo(path)
  assert.equal(info.format, 'jpeg')
  assert.equal(info.mime, 'image/jpeg')
  assert.deepEqual([info.width, info.height], [24, 16])
  assert.equal(info.decodable, true)
})

test('a .jpg extension does not decide the format', () => {
  assert.equal(readImageInfo(write('mislabelled.jpg', bytes(png))).format, 'png')
})

test('decodes baseline and progressive JPEG to the same geometry', () => {
  for (const payload of [jpeg, progressive]) {
    const image = decodeJpeg(bytes(payload))
    assert.deepEqual([image.width, image.height], [24, 16])
    assert.equal(image.data.length, 24 * 16 * 4)
    assert.equal(image.data[3], 255)
    // The gradient survives: the left edge is darker than the right edge.
    const left = image.data[(8 * 24 + 1) * 4]
    const right = image.data[(8 * 24 + 22) * 4]
    assert.ok(right > left, `expected a rising gradient (${left} -> ${right})`)
  }
})

test('decodes GIF and BMP fixtures', () => {
  const gifImage = decodeGif(bytes(gif))
  assert.deepEqual([gifImage.width, gifImage.height], [24, 16])
  assert.equal(gifImage.data.length, 24 * 16 * 4)
  const bmpImage = decodeBmp(bytes(bmp))
  assert.deepEqual([bmpImage.width, bmpImage.height], [24, 16])
  assert.equal(bmpImage.data.length, 24 * 16 * 4)
})

test('passes JPEG through untouched and repaints GIF to PNG', () => {
  const jpegPath = write('photo.jpg', bytes(jpeg))
  const jpegUpload = prepareUpload(jpegPath, 2048)
  assert.equal(jpegUpload.mime, 'image/jpeg')
  // Byte-for-byte pass-through: no recompression of a file that needs no repaint.
  assert.equal(bytes(jpegUpload.dataUrl.split(',')[1]).length, bytes(jpeg).length)

  const gifPath = write('anim.gif', bytes(gif))
  assert.equal(prepareUpload(gifPath, 2048).mime, 'image/png')
})

test('crops a JPEG region locally, as vision_zoom requires', () => {
  const path = write('portrait-no-ext', bytes(progressive))
  const prepared = prepareCropUpload(path, { x1: 4, y1: 2, x2: 16, y2: 12 }, { scale: 2, maxEdge: 2048 })
  assert.equal(prepared.view.viewDims.width, 24)
  assert.equal(prepared.view.viewDims.height, 20)
  assert.match(prepared.dataUrl, /^data:image\/png;base64,/)
  const crop = decodeImage(bytes(prepared.dataUrl.split(',')[1]), 'png')
  const source = decodeJpeg(bytes(progressive))
  // The crop is the same pixels as the source region, just replicated 2x.
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 4; x++) {
      const fromCrop = (y * crop.width + x) * 4
      const fromSource = ((2 + Math.floor(y / 2)) * source.width + 4 + Math.floor(x / 2)) * 4
      assert.deepEqual(
        [crop.data[fromCrop], crop.data[fromCrop + 1], crop.data[fromCrop + 2]],
        [source.data[fromSource], source.data[fromSource + 1], source.data[fromSource + 2]],
      )
    }
  }
})

test('downscales JPEG when the long edge exceeds the cap', () => {
  const path = write('large.jpg', bytes(jpeg))
  const upload = prepareUpload(path, 12)
  assert.equal(upload.mime, 'image/png')
  assert.ok(Math.max(upload.view.viewDims.width, upload.view.viewDims.height) <= 12, JSON.stringify(upload.view.viewDims))
})

test('WebP is served as-is but cannot be cropped', () => {
  const path = write('shot.webp', bytes(webp))
  const upload = prepareUpload(path, 32)
  assert.equal(upload.mime, 'image/webp')
  assert.throws(() => prepareCropUpload(path, { x1: 0, y1: 0, x2: 8, y2: 8 }, { maxEdge: 2048 }), /WebP/)
})
