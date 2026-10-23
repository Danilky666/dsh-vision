// Dependency-free BMP reader for the uncompressed variants that show up in
// screenshots: 8-bit palette, 24-bit BGR, 32-bit BGRA. Compressed BMP (RLE,
// JPEG/PNG-embedded) is rejected with a clear message instead of being guessed
// at.

import type { PngImage } from './png.js'

export class BmpError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BmpError'
  }
}

interface BmpHeader {
  width: number
  height: number
  bitCount: number
  dataOffset: number
  paletteCount: number
  bottomUp: boolean
}

function header(bytes: Uint8Array): BmpHeader {
  if (bytes.length < 26 || bytes[0] !== 0x42 || bytes[1] !== 0x4d) throw new BmpError('not a BMP file')
  const dataOffset = bytes[10] | (bytes[11] << 8) | (bytes[12] << 16) | (bytes[13] << 24)
  const dibSize = bytes[14] | (bytes[15] << 8) | (bytes[16] << 16) | (bytes[17] << 24)
  if (dibSize < 40) throw new BmpError(`unsupported BMP header size ${dibSize}`)
  const rawWidth = bytes[18] | (bytes[19] << 8) | (bytes[20] << 16) | (bytes[21] << 24)
  const rawHeight = bytes[22] | (bytes[23] << 8) | (bytes[24] << 16) | (bytes[25] << 24)
  const bitCount = bytes[28] | (bytes[29] << 8)
  const compression = bytes[30] | (bytes[31] << 8) | (bytes[32] << 16) | (bytes[33] << 24)
  const paletteCount = dibSize >= 36 ? bytes[46] | (bytes[47] << 8) | (bytes[48] << 16) | (bytes[49] << 24) : 0
  const width = Math.abs(rawWidth)
  const height = Math.abs(rawHeight)
  if (!width || !height) throw new BmpError('BMP has no image size')
  if (compression !== 0 && compression !== 3) throw new BmpError(`unsupported BMP compression ${compression} (only uncompressed bitmaps)`)
  if (bitCount !== 8 && bitCount !== 24 && bitCount !== 32) throw new BmpError(`unsupported BMP bit depth ${bitCount} (8, 24 or 32)`)
  return { width, height, bitCount, dataOffset, paletteCount, bottomUp: rawHeight > 0 }
}

export function bmpDims(bytes: Uint8Array): { width: number; height: number } {
  const info = header(bytes)
  return { width: info.width, height: info.height }
}

/** Decode an uncompressed BMP into RGBA. */
export function decodeBmp(bytes: Uint8Array): PngImage {
  const info = header(bytes)
  const { width, height, bitCount, dataOffset, bottomUp } = info
  const data = new Uint8Array(width * height * 4)
  let palette: Uint8Array | null = null
  if (bitCount === 8) {
    const count = info.paletteCount || 256
    const dibSize = bytes[14] | (bytes[15] << 8) | (bytes[16] << 16) | (bytes[17] << 24)
    const start = 14 + dibSize
    palette = new Uint8Array(count * 3)
    for (let i = 0; i < count; i++) {
      const entry = start + i * 4
      if (entry + 2 >= bytes.length) break
      palette[i * 3] = bytes[entry + 2]
      palette[i * 3 + 1] = bytes[entry + 1]
      palette[i * 3 + 2] = bytes[entry]
    }
  }
  const stride = Math.floor((bitCount * width + 31) / 32) * 4
  for (let y = 0; y < height; y++) {
    const sourceRow = bottomUp ? height - 1 - y : y
    const rowStart = dataOffset + sourceRow * stride
    if (rowStart + stride > bytes.length + 3) break
    for (let x = 0; x < width; x++) {
      const target = (y * width + x) * 4
      if (bitCount === 8) {
        const index = bytes[rowStart + x] ?? 0
        data[target] = palette?.[index * 3] ?? 0
        data[target + 1] = palette?.[index * 3 + 1] ?? 0
        data[target + 2] = palette?.[index * 3 + 2] ?? 0
        data[target + 3] = 255
      } else {
        const source = rowStart + x * (bitCount / 8)
        data[target] = bytes[source + 2] ?? 0
        data[target + 1] = bytes[source + 1] ?? 0
        data[target + 2] = bytes[source] ?? 0
        data[target + 3] = 255
      }
    }
  }
  return { width, height, data }
}
