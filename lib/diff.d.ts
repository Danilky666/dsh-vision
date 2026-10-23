import type { PngImage } from './png.js';
export declare class DiffError extends Error {
    constructor(message: string);
}
export interface DiffBlock {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    changed: number;
}
export interface BlockDiffResult {
    percent: number;
    changedPixels: number;
    totalPixels: number;
    /** Top differing blocks (box + changed-pixel count), most changed first. */
    blocks: DiffBlock[];
    /** True when the images had different sizes and only the overlap was compared. */
    overlapOnly: boolean;
}
/**
 * Compare two RGBA images pixel by pixel (per-channel tolerance), aggregate
 * per block, and return the top blocks. Same dimensions required — callers
 * handle size mismatch (see imageDiff).
 */
export declare function blockDiff(a: PngImage, b: PngImage, tolerance?: number, blockSize?: number): BlockDiffResult;
/** Diff two PNG files, comparing the overlapping region when sizes differ. */
export declare function imageDiff(aPath: string, bPath: string, tolerance?: number): BlockDiffResult;
export declare function requireImage(path: string): PngImage;
/** @deprecated Use requireImage: the diff accepts every decodable format. */
export declare const requirePng: typeof requireImage;
