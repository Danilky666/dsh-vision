// Deterministic local crop, optionally nearest-neighbor upscaled. The zoom arm
// of the pipeline: the crop replaces the image before upload, so a small region
// reaches the vision model at full resolution. Upscaling is plain pixel
// replication — generative super-resolution is never used (it invents strokes
// and worsens reading).
//
// Input may be any decodable format (PNG, JPEG, GIF, BMP); the crop is always
// written as PNG so nothing is recompressed twice.
import { writeFileSync } from 'node:fs';
import { extname, join, dirname, basename } from 'node:path';
import { encodePng, PngError } from './png.js';
import { decodeImage, readImageInfo, ImageError } from './image.js';
import { parseRegion } from './bbox.js';
export class CropError extends Error {
    constructor(message) {
        super(message);
        this.name = 'CropError';
    }
}
/** Decode any supported image file into RGBA, with actionable errors. */
export function requireImage(path) {
    const info = readImageInfo(path);
    if (!info.decodable) {
        throw new CropError(`${info.format.toUpperCase()} pixels cannot be decoded locally: convert the file to PNG or JPEG first (${path})`);
    }
    try {
        return decodeImage(info.bytes, info.format);
    }
    catch (error) {
        if (error instanceof ImageError || error instanceof PngError)
            throw new CropError(`${path}: ${error.message}`);
        throw new CropError(`cannot read image: ${path}`);
    }
}
/** @deprecated Use requireImage: crops work on every decodable format. */
export const requirePng = requireImage;
function upscaleNearest(data, width, height, scale) {
    const scaled = new Uint8Array(width * height * scale * scale * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const src = (y * width + x) * 4;
            for (let dy = 0; dy < scale; dy++) {
                const dstRow = (y * scale + dy) * width * scale * 4;
                for (let dx = 0; dx < scale; dx++) {
                    scaled.set(data.subarray(src, src + 4), dstRow + (x * scale + dx) * 4);
                }
            }
        }
    }
    return { data: scaled, width: width * scale, height: height * scale };
}
/** Extract a pixel box from any decodable image and write it to a new PNG. */
export function cropRegion(imagePath, region, outPath, scale = 1) {
    const image = requireImage(imagePath);
    const x1 = Math.max(0, Math.min(image.width - 1, Math.round(region.x1)));
    const y1 = Math.max(0, Math.min(image.height - 1, Math.round(region.y1)));
    const x2 = Math.max(x1 + 1, Math.min(image.width, Math.round(region.x2)));
    const y2 = Math.max(y1 + 1, Math.min(image.height, Math.round(region.y2)));
    let data = new Uint8Array((x2 - x1) * (y2 - y1) * 4);
    for (let y = y1; y < y2; y++) {
        const rowStart = y * image.width * 4;
        data.set(image.data.subarray(rowStart + x1 * 4, rowStart + x2 * 4), (y - y1) * (x2 - x1) * 4);
    }
    let width = x2 - x1;
    let height = y2 - y1;
    if (scale !== 1) {
        const upscaled = upscaleNearest(data, width, height, scale);
        data = upscaled.data;
        width = upscaled.width;
        height = upscaled.height;
    }
    const suffix = extname(imagePath);
    const stem = suffix ? basename(imagePath, suffix) : basename(imagePath);
    const target = outPath ?? join(dirname(imagePath), `${stem}.crop${scale === 1 ? '' : `@${scale}x`}.png`);
    writeFileSync(target, encodePng({ width, height, data }));
    return { path: target, width, height, scale };
}
/** @deprecated Use cropRegion: crops work on every decodable format. */
export const cropPngRegion = cropRegion;
/** Clamp a region string against an image's real size (helper for tool args). */
export function regionFor(imagePath, region) {
    if (!region)
        return null;
    const info = readImageInfo(imagePath);
    return parseRegion(region, info.width, info.height);
}
