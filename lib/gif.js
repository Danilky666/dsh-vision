// Dependency-free GIF decoder (87a/89a, LZW, interlaced, transparency).
//
// Same contract as the PNG and JPEG codecs: RGBA out, so cropping and zooming
// work on GIFs too. A GIF is a container of frames; for inspection purposes the
// first frame is the image, so decoding stops there (an animated GIF is still
// served as a still). Transparent pixels keep whatever the first frame's
// background left behind — the declared background colour when the file has
// one, white otherwise — because a transparent upload reads as black in most
// endpoints.
export class GifError extends Error {
    constructor(message) {
        super(message);
        this.name = 'GifError';
    }
}
const SIGNATURES = ['GIF87a', 'GIF89a'];
function checkSignature(bytes) {
    if (bytes.length < 13)
        throw new GifError('not a GIF file');
    const head = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5]);
    if (!SIGNATURES.includes(head))
        throw new GifError('not a GIF file');
}
export function gifDims(bytes) {
    checkSignature(bytes);
    return { width: bytes[6] | (bytes[7] << 8), height: bytes[8] | (bytes[9] << 8) };
}
function readPalette(bytes, pos, size) {
    const palette = new Uint8Array(size * 3);
    palette.set(bytes.subarray(pos, pos + size * 3));
    return palette;
}
function readSubBlocks(bytes, start) {
    const chunks = [];
    let pos = start;
    let total = 0;
    while (pos < bytes.length) {
        const size = bytes[pos++];
        if (size === 0)
            break;
        chunks.push(bytes.subarray(pos, pos + size));
        total += size;
        pos += size;
    }
    const data = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks) {
        data.set(chunk, at);
        at += chunk.length;
    }
    return { data, pos };
}
function lzwDecode(minCodeSize, data, pixelCount) {
    const clearCode = 1 << minCodeSize;
    const endCode = clearCode + 1;
    const prefix = new Int32Array(4096);
    const suffix = new Uint8Array(4096);
    const stack = new Uint8Array(4097);
    for (let i = 0; i < clearCode; i++)
        suffix[i] = i;
    const out = new Uint8Array(pixelCount);
    let codeSize = minCodeSize + 1;
    let mask = (1 << codeSize) - 1;
    let nextCode = clearCode + 2;
    let previous = -1;
    let firstChar = 0;
    let datum = 0;
    let bits = 0;
    let pos = 0;
    let outPos = 0;
    while (outPos < pixelCount) {
        while (bits < codeSize) {
            if (pos >= data.length)
                return out;
            datum |= data[pos++] << bits;
            bits += 8;
        }
        const code = datum & mask;
        datum >>= codeSize;
        bits -= codeSize;
        if (code === clearCode) {
            codeSize = minCodeSize + 1;
            mask = (1 << codeSize) - 1;
            nextCode = clearCode + 2;
            previous = -1;
            continue;
        }
        if (code === endCode)
            break;
        if (previous === -1) {
            out[outPos++] = suffix[code];
            firstChar = suffix[code];
            previous = code;
            continue;
        }
        let current = code;
        let top = 0;
        if (code >= nextCode) {
            // KwKwK: the code being defined references itself.
            stack[top++] = firstChar;
            current = previous;
        }
        while (current >= clearCode) {
            stack[top++] = suffix[current];
            current = prefix[current];
        }
        firstChar = suffix[current];
        stack[top++] = firstChar;
        if (nextCode < 4096) {
            prefix[nextCode] = previous;
            suffix[nextCode] = firstChar;
            nextCode++;
            if (nextCode === 1 << codeSize && codeSize < 12) {
                codeSize++;
                mask = (1 << codeSize) - 1;
            }
        }
        previous = code;
        while (top > 0 && outPos < pixelCount)
            out[outPos++] = stack[--top];
    }
    return out;
}
/** Decode the first frame of a GIF into RGBA. */
export function decodeGif(bytes) {
    checkSignature(bytes);
    const width = bytes[6] | (bytes[7] << 8);
    const height = bytes[8] | (bytes[9] << 8);
    if (!width || !height)
        throw new GifError('GIF has no image size');
    const packed = bytes[10];
    const globalTableSize = packed & 0x80 ? 2 << (packed & 7) : 0;
    const backgroundIndex = bytes[11];
    let pos = 13;
    let globalPalette = null;
    if (globalTableSize > 0) {
        globalPalette = readPalette(bytes, pos, globalTableSize);
        pos += globalTableSize * 3;
    }
    const data = new Uint8Array(width * height * 4);
    // Opaque background: the declared background colour, else white.
    let bgR = 255;
    let bgG = 255;
    let bgB = 255;
    if (globalPalette && backgroundIndex * 3 + 2 < globalPalette.length) {
        bgR = globalPalette[backgroundIndex * 3];
        bgG = globalPalette[backgroundIndex * 3 + 1];
        bgB = globalPalette[backgroundIndex * 3 + 2];
    }
    for (let i = 0; i < width * height; i++) {
        data[i * 4] = bgR;
        data[i * 4 + 1] = bgG;
        data[i * 4 + 2] = bgB;
        data[i * 4 + 3] = 255;
    }
    let transparentIndex = -1;
    while (pos < bytes.length) {
        const introducer = bytes[pos++];
        if (introducer === 0x3b)
            break;
        if (introducer === 0x21) {
            const label = bytes[pos++];
            const block = readSubBlocks(bytes, pos);
            pos = block.pos;
            if (label === 0xf9 && block.data.length >= 4) {
                const flags = block.data[0];
                transparentIndex = flags & 1 ? block.data[3] : -1;
            }
            continue;
        }
        if (introducer !== 0x2c)
            break; // unknown block: stop rather than misread the file
        const left = bytes[pos] | (bytes[pos + 1] << 8);
        const top = bytes[pos + 2] | (bytes[pos + 3] << 8);
        const frameWidth = bytes[pos + 4] | (bytes[pos + 5] << 8);
        const frameHeight = bytes[pos + 6] | (bytes[pos + 7] << 8);
        const framePacked = bytes[pos + 8];
        pos += 9;
        let palette = globalPalette;
        if (framePacked & 0x80) {
            const size = 2 << (framePacked & 7);
            palette = readPalette(bytes, pos, size);
            pos += size * 3;
        }
        const interlaced = (framePacked & 0x40) !== 0;
        if (pos >= bytes.length)
            break;
        const minCodeSize = bytes[pos++];
        const image = readSubBlocks(bytes, pos);
        pos = image.pos;
        if (!palette)
            throw new GifError('GIF frame has no colour table');
        const indices = lzwDecode(minCodeSize, image.data, frameWidth * frameHeight);
        const rows = [];
        if (interlaced) {
            const order = [[0, 8], [4, 8], [2, 4], [1, 2]];
            for (const [start, step] of order) {
                for (let y = start; y < frameHeight; y += step)
                    rows.push(y);
            }
        }
        else {
            for (let y = 0; y < frameHeight; y++)
                rows.push(y);
        }
        for (let index = 0; index < rows.length; index++) {
            const y = rows[index];
            const canvasY = top + y;
            if (canvasY < 0 || canvasY >= height)
                continue;
            for (let x = 0; x < frameWidth; x++) {
                const canvasX = left + x;
                if (canvasX < 0 || canvasX >= width)
                    continue;
                const paletteIndex = indices[index * frameWidth + x];
                if (paletteIndex === transparentIndex)
                    continue;
                const target = (canvasY * width + canvasX) * 4;
                data[target] = palette[paletteIndex * 3] ?? 0;
                data[target + 1] = palette[paletteIndex * 3 + 1] ?? 0;
                data[target + 2] = palette[paletteIndex * 3 + 2] ?? 0;
                data[target + 3] = 255;
            }
        }
        // First frame only: a still is what these tools inspect.
        break;
    }
    return { width, height, data };
}
