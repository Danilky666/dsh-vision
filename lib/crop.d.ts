import { type PngImage } from './png.js';
export declare class CropError extends Error {
    constructor(message: string);
}
/** Decode any supported image file into RGBA, with actionable errors. */
export declare function requireImage(path: string): PngImage;
/** @deprecated Use requireImage: crops work on every decodable format. */
export declare const requirePng: typeof requireImage;
/** Extract a pixel box from any decodable image and write it to a new PNG. */
export declare function cropRegion(imagePath: string, region: {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
}, outPath: string | null, scale?: number): {
    path: string;
    width: number;
    height: number;
    scale: number;
};
/** @deprecated Use cropRegion: crops work on every decodable format. */
export declare const cropPngRegion: typeof cropRegion;
/** Clamp a region string against an image's real size (helper for tool args). */
export declare function regionFor(imagePath: string, region?: string): {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
} | null;
