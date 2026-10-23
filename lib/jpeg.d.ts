import type { PngImage } from './png.js';
export declare class JpegError extends Error {
    constructor(message: string);
}
export interface Dims {
    width: number;
    height: number;
}
/** EXIF orientation (1..8) of a JPEG file, 1 when absent. */
export declare function jpegOrientation(bytes: Uint8Array): number;
/** Image dimensions from the frame header, without decoding pixels (orientation applied). */
export declare function jpegDims(bytes: Uint8Array): Dims;
/** Decode a JPEG file into RGBA (EXIF orientation applied). */
export declare function decodeJpeg(bytes: Uint8Array): PngImage;
