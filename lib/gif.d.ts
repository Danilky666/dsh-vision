import type { PngImage } from './png.js';
export declare class GifError extends Error {
    constructor(message: string);
}
export declare function gifDims(bytes: Uint8Array): {
    width: number;
    height: number;
};
/** Decode the first frame of a GIF into RGBA. */
export declare function decodeGif(bytes: Uint8Array): PngImage;
