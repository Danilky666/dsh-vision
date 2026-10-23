import type { PngImage } from './png.js';
import { ImageError } from './image.js';
import type { ViewTransform } from './coords.js';
export { ImageError };
export interface PreparedUpload {
    /** data URL ready for the vision API. */
    dataUrl: string;
    mime: string;
    /** What the model saw, mapped to the original image. */
    view: ViewTransform;
    /** Original image size. */
    originalDims: {
        width: number;
        height: number;
    };
}
export interface Dims {
    width: number;
    height: number;
}
/** Integer-factor mean-pool downscale: every k×k block averages to one pixel. */
export declare function meanPoolDownscale(image: PngImage, factor: number): PngImage;
/** Pixel size of an image file, sniffed from its bytes (orientation applied). */
export declare function readImageDims(path: string): Dims;
/**
 * Prepare one image path for upload.
 *
 * PNG/JPEG pass through byte-for-byte when no repaint is needed (no downscale,
 * no EXIF rotation); GIF/BMP are repainted to PNG because their first frame and
 * transparency are more predictable that way; WebP passes through as-is.
 */
export declare function prepareUpload(path: string, maxEdge: number): PreparedUpload;
/**
 * Crop a region locally (optionally upscaled), then prepare the crop for
 * upload. Works on every decodable format (PNG, JPEG, GIF, BMP); WebP is
 * rejected with an actionable message. The crop REPLACES the image: the model
 * sees only this region, at full resolution. The view transform maps model
 * boxes back to original-image coordinates.
 */
export declare function prepareCropUpload(path: string, box: {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
}, options: {
    scale?: number;
    maxEdge: number;
}): PreparedUpload;
