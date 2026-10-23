import type { PngImage } from './png.js';
export declare class ImageError extends Error {
    constructor(message: string);
}
export type ImageFormat = 'png' | 'jpeg' | 'gif' | 'webp' | 'bmp';
/** MIME type per sniffed format. */
export declare const MIME_BY_FORMAT: Record<ImageFormat, string>;
/** Formats the bundled codecs can repaint (crop, zoom, downscale, diff). */
export declare const DECODABLE: ReadonlySet<ImageFormat>;
export interface ImageInfo {
    path: string;
    bytes: Buffer;
    /** Format sniffed from the bytes, never from the extension. */
    format: ImageFormat;
    mime: string;
    /** Pixel size, already accounting for EXIF orientation. */
    width: number;
    height: number;
    /** EXIF orientation (1 for everything but JPEG). */
    orientation: number;
    /** Whether the bundled codecs can repaint the pixels. */
    decodable: boolean;
}
/** Identify an image format by its magic bytes. */
export declare function sniffFormat(bytes: Uint8Array): ImageFormat | null;
/**
 * Read one image file: bytes, sniffed format, MIME type, pixel size and EXIF
 * orientation (1 for everything but JPEG). Dimensions account for orientation,
 * so they always describe the pixels decodeImage returns.
 */
export declare function readImageInfo(path: string): ImageInfo;
/** Decode raw bytes of any decodable format into RGBA. */
export declare function decodeImage(bytes: Uint8Array, format?: ImageFormat | null): PngImage;
/** Decode one image file into RGBA (any decodable format). */
export declare function readImageFile(path: string): PngImage;
