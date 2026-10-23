// Upload preparation and cropping, zero dependencies and format-agnostic.
//
// Every decodable format (PNG, JPEG, GIF, BMP) is decoded locally by the
// bundled codecs, so a crop, a zoom or a downscale works on a phone JPEG
// exactly as it does on a screenshot PNG. WebP is the exception: its bitstream
// is not decoded here, so it is passed through untouched for mapping/reading
// and rejected with an actionable message when a crop is required.
//
// Format is sniffed from the bytes, never from the extension — a DSH attachment
// cache object has no extension at all. Two rules drive the flow:
//   · whatever is uploaded must match the dimensions reported back, so a file
//     is repainted (decode → resize → PNG) whenever EXIF orientation or the
//     long-edge cap would otherwise desync the two;
//   · an untouched file is uploaded byte-for-byte (JPEG stays JPEG), because
//     re-encoding costs quality and bytes for nothing.

import type { PngImage } from './png.js'
import { encodePng } from './png.js'
import { decodeImage, readImageInfo, ImageError } from './image.js'
import type { ViewTransform } from './coords.js'

export { ImageError }

export interface PreparedUpload {
  /** data URL ready for the vision API. */
  dataUrl: string
  mime: string
  /** What the model saw, mapped to the original image. */
  view: ViewTransform
  /** Original image size. */
  originalDims: { width: number; height: number }
}

export interface Dims {
  width: number
  height: number
}

/** Integer-factor mean-pool downscale: every k×k block averages to one pixel. */
export function meanPoolDownscale(image: PngImage, factor: number): PngImage {
  const width = Math.floor(image.width / factor)
  const height = Math.floor(image.height / factor)
  const data = new Uint8Array(width * height * 4)
  const count = factor * factor
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let dy = 0; dy < factor; dy++) {
        const row = (y * factor + dy) * image.width * 4
        for (let dx = 0; dx < factor; dx++) {
          const i = row + (x * factor + dx) * 4
          r += image.data[i]
          g += image.data[i + 1]
          b += image.data[i + 2]
          a += image.data[i + 3]
        }
      }
      const o = (y * width + x) * 4
      data[o] = Math.round(r / count)
      data[o + 1] = Math.round(g / count)
      data[o + 2] = Math.round(b / count)
      data[o + 3] = Math.round(a / count)
    }
  }
  return { width, height, data }
}

/** Pixel size of an image file, sniffed from its bytes (orientation applied). */
export function readImageDims(path: string): Dims {
  const info = readImageInfo(path)
  return { width: info.width, height: info.height }
}

/** Downscale by the smallest integer factor that brings the long edge under the cap. */
function fitToCap(image: PngImage, maxEdge: number): PngImage {
  const longEdge = Math.max(image.width, image.height)
  if (longEdge <= maxEdge) return image
  const factor = Math.ceil(longEdge / maxEdge)
  const view = meanPoolDownscale(image, factor)
  // Mean pooling rounds down; a hair of extra reduction beats exceeding the cap.
  return view.width > 0 && view.height > 0 ? view : image
}

/**
 * Prepare one image path for upload.
 *
 * PNG/JPEG pass through byte-for-byte when no repaint is needed (no downscale,
 * no EXIF rotation); GIF/BMP are repainted to PNG because their first frame and
 * transparency are more predictable that way; WebP passes through as-is.
 */
export function prepareUpload(path: string, maxEdge: number): PreparedUpload {
  const info = readImageInfo(path)
  const needsResize = Math.max(info.width, info.height) > maxEdge
  const needsReorient = info.format === 'jpeg' && info.orientation > 1
  const repaint = info.decodable && (needsResize || needsReorient || info.format === 'gif' || info.format === 'bmp')
  if (!repaint) {
    return {
      dataUrl: `data:${info.mime};base64,${info.bytes.toString('base64')}`,
      mime: info.mime,
      originalDims: { width: info.width, height: info.height },
      view: { viewBox: { x1: 0, y1: 0, x2: info.width, y2: info.height }, viewDims: { width: info.width, height: info.height } },
    }
  }
  const image = decodeImage(info.bytes, info.format)
  const view = fitToCap(image, maxEdge)
  return {
    dataUrl: `data:image/png;base64,${encodePng(view).toString('base64')}`,
    mime: 'image/png',
    originalDims: { width: info.width, height: info.height },
    view: { viewBox: { x1: 0, y1: 0, x2: info.width, y2: info.height }, viewDims: { width: view.width, height: view.height } },
  }
}

/** Nearest-neighbor upscale: pixel replication, never generative. */
function upscaleNearest(image: PngImage, scale: number): PngImage {
  const width = image.width * scale
  const height = image.height * scale
  const data = new Uint8Array(width * height * 4)
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const source = (y * image.width + x) * 4
      for (let dy = 0; dy < scale; dy++) {
        const row = (y * scale + dy) * width * 4
        for (let dx = 0; dx < scale; dx++) {
          data.set(image.data.subarray(source, source + 4), row + (x * scale + dx) * 4)
        }
      }
    }
  }
  return { width, height, data }
}

/**
 * Crop a region locally (optionally upscaled), then prepare the crop for
 * upload. Works on every decodable format (PNG, JPEG, GIF, BMP); WebP is
 * rejected with an actionable message. The crop REPLACES the image: the model
 * sees only this region, at full resolution. The view transform maps model
 * boxes back to original-image coordinates.
 */
export function prepareCropUpload(path: string, box: { x1: number; y1: number; x2: number; y2: number }, options: { scale?: number; maxEdge: number }): PreparedUpload {
  const info = readImageInfo(path)
  if (!info.decodable) {
    throw new ImageError(`WebP pixels cannot be decoded locally, so the region cannot be cropped: convert the file to PNG or JPEG first (${path})`)
  }
  const image = decodeImage(info.bytes, info.format)
  const x1 = Math.max(0, Math.min(image.width - 1, Math.round(box.x1)))
  const y1 = Math.max(0, Math.min(image.height - 1, Math.round(box.y1)))
  const x2 = Math.max(x1 + 1, Math.min(image.width, Math.round(box.x2)))
  const y2 = Math.max(y1 + 1, Math.min(image.height, Math.round(box.y2)))
  const data = new Uint8Array((x2 - x1) * (y2 - y1) * 4)
  for (let y = y1; y < y2; y++) {
    const rowStart = y * image.width * 4
    data.set(image.data.subarray(rowStart + x1 * 4, rowStart + x2 * 4), (y - y1) * (x2 - x1) * 4)
  }
  let crop: PngImage = { width: x2 - x1, height: y2 - y1, data }
  const scale = options.scale && options.scale > 1 ? Math.round(options.scale) : 1
  if (scale > 1) crop = upscaleNearest(crop, scale)
  const view = fitToCap(crop, options.maxEdge)
  return {
    dataUrl: `data:image/png;base64,${encodePng(view).toString('base64')}`,
    mime: 'image/png',
    originalDims: { width: image.width, height: image.height },
    view: { viewBox: { x1, y1, x2, y2 }, viewDims: { width: view.width, height: view.height } },
  }
}
