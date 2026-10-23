import type { PngImage } from './png.js';
export declare class BmpError extends Error {
    constructor(message: string);
}
export declare function bmpDims(bytes: Uint8Array): {
    width: number;
    height: number;
};
/** Decode an uncompressed BMP into RGBA. */
export declare function decodeBmp(bytes: Uint8Array): PngImage;
