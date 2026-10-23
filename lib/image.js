// Format detection and decoding for every image the tools accept.
//
// Detection is by magic bytes, never by file extension: a DSH attachment cache
// object (`7c66…962d`) has no extension at all, and a `.jpg` name may hold a
// PNG. Everything here returns RGBA in the same shape as the bundled PNG codec,
// so crop / zoom / diff / downscale are format-agnostic.
import { readFileSync } from 'node:fs';
import { decodePng } from './png.js';
import { decodeJpeg, jpegDims, jpegOrientation } from './jpeg.js';
import { decodeGif, gifDims } from './gif.js';
import { decodeBmp, bmpDims } from './bmp.js';
export class ImageError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ImageError';
    }
}
/** MIME type per sniffed format. */
export const MIME_BY_FORMAT = {
    png: 'image/png',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    bmp: 'image/bmp',
};
/** Formats the bundled codecs can repaint (crop, zoom, downscale, diff). */
export const DECODABLE = new Set(['png', 'jpeg', 'gif', 'bmp']);
/** Identify an image format by its magic bytes. */
export function sniffFormat(bytes) {
    if (bytes.length >= 8
        && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
        && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
        return 'png';
    }
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
        return 'jpeg';
    if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
        return bytes[4] === 0x37 || bytes[4] === 0x39 ? 'gif' : null;
    }
    if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
        && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
        return 'webp';
    }
    if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d)
        return 'bmp';
    return null;
}
function pngDims(bytes) {
    // Header-only read: a full decode is wasteful just for dimensions.
    if (bytes.length < 24)
        throw new ImageError('truncated PNG header');
    const width = (bytes[16] << 24) | (bytes[17] << 16) | (bytes[18] << 8) | bytes[19];
    const height = (bytes[20] << 24) | (bytes[21] << 16) | (bytes[22] << 8) | bytes[23];
    if (!width || !height)
        throw new ImageError('PNG has no image size');
    return { width, height };
}
function webpDims(bytes) {
    const kind = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
    if (kind === 'VP8X') {
        return {
            width: 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)),
            height: 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16)),
        };
    }
    if (kind === 'VP8 ' && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
        return { width: (bytes[26] | (bytes[27] << 8)) & 0x3fff, height: (bytes[28] | (bytes[29] << 8)) & 0x3fff };
    }
    if (kind === 'VP8L' && bytes[20] === 0x2f) {
        const bits = bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24);
        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    throw new ImageError('cannot read WebP dimensions (unknown variant)');
}
function dimsOf(bytes, format) {
    switch (format) {
        case 'png': return pngDims(bytes);
        case 'jpeg': return jpegDims(bytes);
        case 'gif': return gifDims(bytes);
        case 'bmp': return bmpDims(bytes);
        case 'webp': return webpDims(bytes);
    }
}
/**
 * Read one image file: bytes, sniffed format, MIME type, pixel size and EXIF
 * orientation (1 for everything but JPEG). Dimensions account for orientation,
 * so they always describe the pixels decodeImage returns.
 */
export function readImageInfo(path) {
    let bytes;
    try {
        bytes = readFileSync(path);
    }
    catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new ImageError(`cannot read image: ${path} (${reason})`);
    }
    const format = sniffFormat(bytes);
    if (!format) {
        throw new ImageError(`unrecognized image format: ${path} (supported: PNG, JPEG, GIF, WebP, BMP; the extension does not matter)`);
    }
    let dims;
    try {
        dims = dimsOf(bytes, format);
    }
    catch (error) {
        if (error instanceof ImageError)
            throw error;
        throw new ImageError(`${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
    return {
        path,
        bytes,
        format,
        mime: MIME_BY_FORMAT[format],
        width: dims.width,
        height: dims.height,
        orientation: format === 'jpeg' ? jpegOrientation(bytes) : 1,
        decodable: DECODABLE.has(format),
    };
}
/** Decode raw bytes of any decodable format into RGBA. */
export function decodeImage(bytes, format = sniffFormat(bytes)) {
    switch (format) {
        case 'png': return decodePng(bytes);
        case 'jpeg': return decodeJpeg(bytes);
        case 'gif': return decodeGif(bytes);
        case 'bmp': return decodeBmp(bytes);
        case 'webp':
            throw new ImageError('WebP pixels cannot be decoded locally; convert the file to PNG or JPEG to crop or zoom it');
        case null:
            throw new ImageError('unrecognized image format (supported: PNG, JPEG, GIF, WebP, BMP)');
    }
}
/** Decode one image file into RGBA (any decodable format). */
export function readImageFile(path) {
    const info = readImageInfo(path);
    if (!info.decodable) {
        throw new ImageError(`${info.format.toUpperCase()} pixels cannot be decoded locally: convert the file to PNG or JPEG first (${path})`);
    }
    return decodeImage(info.bytes, info.format);
}
