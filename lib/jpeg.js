// Dependency-free JPEG decoder (8-bit, Huffman, baseline + progressive).
//
// The plugin is zero-dependency on purpose, but the vision tools must work on
// the images agents actually get — phone photos and saved screenshots are
// usually JPEG, and a DSH attachment cache object has no extension at all.
// Cropping, zooming and downscaling need real pixels, so the bytes are decoded
// here instead of being handed to the model raw.
//
// Output is RGBA in the same shape as the bundled PNG codec, so every
// downstream step is format-agnostic. Supported: baseline (SOF0), extended
// sequential (SOF1), progressive (SOF2), 1 or 3 components (grayscale,
// YCbCr/RGB), arbitrary sampling factors, restart intervals, EXIF orientation.
// Not supported (rejected with a clear message): 12-bit, arithmetic coding,
// lossless, and CMYK/YCCK 4-component files.
export class JpegError extends Error {
    constructor(message) {
        super(message);
        this.name = 'JpegError';
    }
}
/** Zigzag index -> natural (row-major) index inside an 8x8 block. */
const ZIGZAG = new Int32Array([
    0, 1, 8, 16, 9, 2, 3, 10,
    17, 24, 32, 25, 18, 11, 4, 5,
    12, 19, 26, 33, 40, 48, 41, 34,
    27, 20, 13, 6, 7, 14, 21, 28,
    35, 42, 49, 56, 57, 50, 43, 36,
    29, 22, 15, 23, 30, 37, 44, 51,
    58, 59, 52, 45, 38, 31, 39, 46,
    53, 60, 61, 54, 47, 55, 62, 63,
]);
const IDCT_BASIS = (() => {
    const basis = new Float64Array(64);
    for (let x = 0; x < 8; x++) {
        for (let u = 0; u < 8; u++) {
            const scale = u === 0 ? Math.SQRT1_2 : 1;
            basis[x * 8 + u] = 0.5 * scale * Math.cos(((2 * x + 1) * u * Math.PI) / 16);
        }
    }
    return basis;
})();
// Scratch buffers reused by every block: single-threaded, sequential decoding.
const SCRATCH_SOURCE = new Float64Array(64);
const SCRATCH_MID = new Float64Array(64);
const readUint16 = (bytes, pos) => (bytes[pos] << 8) | bytes[pos + 1];
/** Thrown by the entropy reader when it reaches a marker instead of data. */
class MarkerSignal {
    marker;
    constructor(marker) {
        this.marker = marker;
    }
}
class EntropyReader {
    bytes;
    pos;
    acc = 0;
    count = 0;
    /** Marker hit while reading entropy data (-1 when none). */
    marker = -1;
    constructor(bytes, offset) {
        this.bytes = bytes;
        this.pos = offset;
    }
    /** Read one entropy byte, undoing 0xFF00 stuffing; throws MarkerSignal on a marker. */
    byte() {
        const bytes = this.bytes;
        if (this.pos >= bytes.length) {
            this.pos = bytes.length;
            throw new MarkerSignal(-1);
        }
        const value = bytes[this.pos++];
        if (value !== 0xff)
            return value;
        let next = bytes[this.pos];
        while (next === 0xff) {
            this.pos++;
            next = bytes[this.pos];
        }
        if (next === 0x00) {
            this.pos++;
            return 0xff;
        }
        if (next === undefined)
            throw new MarkerSignal(-1);
        this.pos--;
        throw new MarkerSignal(next);
    }
    /** Refill the bit accumulator; a marker stops the refill and pads with zeros. */
    fill() {
        while (this.count <= 8 && this.marker < 0) {
            try {
                this.acc = ((this.acc << 8) | this.byte()) & 0xffff;
                this.count += 8;
            }
            catch (signal) {
                if (signal instanceof MarkerSignal) {
                    this.marker = signal.marker;
                    break;
                }
                throw signal;
            }
        }
    }
    bit() {
        if (this.count === 0)
            this.fill();
        if (this.count === 0)
            return 0;
        this.count--;
        return (this.acc >> this.count) & 1;
    }
    bits(length) {
        let value = 0;
        for (let i = 0; i < length; i++)
            value = value * 2 + this.bit();
        return value;
    }
    receiveExtend(size) {
        if (size === 0)
            return 0;
        const value = this.bits(size);
        return value < 1 << (size - 1) ? value - (1 << size) + 1 : value;
    }
    /** Skip a restart marker and drop any buffered bits. */
    skipRestart() {
        this.pos += 2;
        this.acc = 0;
        this.count = 0;
        this.marker = -1;
    }
}
class HuffTable {
    maxcode = new Int32Array(17).fill(-1);
    mincode = new Int32Array(17);
    valptr = new Int32Array(17);
    symbols;
    constructor(spec) {
        this.symbols = spec.symbols;
        let code = 0;
        let symbol = 0;
        for (let length = 1; length <= 16; length++) {
            const count = spec.counts[length - 1] ?? 0;
            this.valptr[length] = symbol;
            this.mincode[length] = code;
            symbol += count;
            code += count;
            this.maxcode[length] = count > 0 ? code - 1 : -1;
            if (code > 1 << length)
                throw new JpegError('invalid Huffman table');
            code <<= 1;
        }
    }
    decode(reader) {
        let code = 0;
        for (let length = 1; length <= 16; length++) {
            code = (code << 1) | reader.bit();
            const max = this.maxcode[length];
            if (max >= 0 && code <= max)
                return this.symbols[this.valptr[length] + code - this.mincode[length]];
        }
        throw new JpegError('invalid Huffman code in JPEG data');
    }
}
function isFrameMarker(marker) {
    return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}
function parseFrame(bytes, marker, start) {
    if (marker === 0xc3 || marker === 0xc7 || marker === 0xcb || marker === 0xcf) {
        throw new JpegError('unsupported JPEG variant (lossless or arithmetic coding)');
    }
    const precision = bytes[start];
    if (precision !== 8)
        throw new JpegError(`unsupported JPEG sample precision ${precision} (only 8-bit)`);
    const height = readUint16(bytes, start + 1);
    const width = readUint16(bytes, start + 3);
    const count = bytes[start + 5];
    if (!width || !height)
        throw new JpegError('JPEG has no frame size (DNL marker is not supported)');
    if (count !== 1 && count !== 3) {
        throw new JpegError(`unsupported JPEG component count ${count} (CMYK-style files must be converted to RGB first)`);
    }
    const components = [];
    let maxH = 1;
    let maxV = 1;
    for (let i = 0; i < count; i++) {
        const offset = start + 6 + i * 3;
        const id = bytes[offset];
        const sampling = bytes[offset + 1];
        const quantTable = bytes[offset + 2];
        const h = sampling >> 4;
        const v = sampling & 15;
        if (h < 1 || v < 1 || h > 4 || v > 4)
            throw new JpegError(`invalid JPEG sampling factors ${h}x${v}`);
        components.push({
            id, h, v, quantTable,
            predictor: 0, coef: new Int16Array(0), stride: 0,
            blocksPerLine: 0, blocksPerColumn: 0,
            sampleWidth: 0, sampleHeight: 0,
            dcTable: null, acTable: null,
        });
        maxH = Math.max(maxH, h);
        maxV = Math.max(maxV, v);
    }
    const mcusPerLine = Math.ceil(width / (8 * maxH));
    const mcusPerColumn = Math.ceil(height / (8 * maxV));
    for (const component of components) {
        component.blocksPerLine = Math.ceil((width * component.h) / (8 * maxH));
        component.blocksPerColumn = Math.ceil((height * component.v) / (8 * maxV));
        component.stride = mcusPerLine * component.h;
        component.sampleWidth = Math.ceil((width * component.h) / maxH);
        component.sampleHeight = Math.ceil((height * component.v) / maxV);
        component.coef = new Int16Array(component.stride * mcusPerColumn * component.v * 64);
    }
    return { width, height, components, maxH, maxV, mcusPerLine, mcusPerColumn, progressive: marker === 0xc2 };
}
/** Apply one correction bit to an already-nonzero coefficient. */
function correctCoefficient(reader, coef, index, bitValue) {
    if (reader.bit() && (coef[index] & bitValue) === 0) {
        coef[index] += coef[index] > 0 ? bitValue : -bitValue;
    }
}
function decodeScan(bytes, offset, frame, components, restartInterval, ss, se, ah, al) {
    const reader = new EntropyReader(bytes, offset);
    const progressive = frame.progressive;
    const single = components.length === 1;
    const mcuColumns = single ? components[0].blocksPerLine : frame.mcusPerLine;
    const mcuRows = single ? components[0].blocksPerColumn : frame.mcusPerColumn;
    const total = mcuColumns * mcuRows;
    let eobrun = 0;
    const decodeBlock = (component, blockIndex) => {
        const coef = component.coef;
        const base = blockIndex * 64;
        if (!progressive) {
            const dcTable = component.dcTable;
            const acTable = component.acTable;
            if (!dcTable || !acTable)
                throw new JpegError('JPEG scan is missing its Huffman table');
            component.predictor += reader.receiveExtend(dcTable.decode(reader));
            coef[base] = component.predictor;
            let k = 1;
            while (k < 64) {
                const rs = acTable.decode(reader);
                const size = rs & 15;
                const run = rs >> 4;
                if (size === 0) {
                    if (run !== 15)
                        break;
                    k += 16;
                    continue;
                }
                k += run;
                if (k > 63)
                    throw new JpegError('AC coefficient index out of range');
                coef[base + ZIGZAG[k]] = reader.receiveExtend(size);
                k++;
            }
            return;
        }
        if (ss === 0) {
            if (ah === 0) {
                const dcTable = component.dcTable;
                if (!dcTable)
                    throw new JpegError('JPEG scan is missing its DC Huffman table');
                component.predictor += reader.receiveExtend(dcTable.decode(reader));
                coef[base] = component.predictor * (1 << al);
            }
            else if (reader.bit()) {
                coef[base] |= 1 << al;
            }
            return;
        }
        const acTable = component.acTable;
        if (!acTable)
            throw new JpegError('JPEG scan is missing its AC Huffman table');
        const bitValue = 1 << al;
        if (ah === 0) {
            if (eobrun > 0) {
                eobrun--;
                return;
            }
            let k = ss;
            while (k <= se) {
                const rs = acTable.decode(reader);
                const size = rs & 15;
                const run = rs >> 4;
                if (size === 0) {
                    if (run !== 15) {
                        eobrun = (1 << run) - 1;
                        if (run > 0)
                            eobrun += reader.bits(run);
                        break;
                    }
                    k += 16;
                    continue;
                }
                k += run;
                if (k > 63)
                    throw new JpegError('AC coefficient index out of range');
                coef[base + ZIGZAG[k]] = reader.receiveExtend(size) * bitValue;
                k++;
            }
            return;
        }
        if (eobrun > 0) {
            for (let k = ss; k <= se; k++) {
                const index = base + ZIGZAG[k];
                if (coef[index] !== 0)
                    correctCoefficient(reader, coef, index, bitValue);
            }
            eobrun--;
            return;
        }
        let k = ss;
        while (k <= se) {
            const rs = acTable.decode(reader);
            const size = rs & 15;
            let run = rs >> 4;
            let value = 0;
            if (size !== 0) {
                if (size !== 1)
                    throw new JpegError('invalid progressive refinement coefficient size');
                value = reader.bit() ? bitValue : -bitValue;
            }
            else if (run !== 15) {
                // EOB run: counts the blocks that follow this one (the current block
                // still needs its correction bits, applied here).
                eobrun = (1 << run) - 1;
                if (run > 0)
                    eobrun += reader.bits(run);
                for (; k <= se; k++) {
                    const index = base + ZIGZAG[k];
                    if (coef[index] !== 0)
                        correctCoefficient(reader, coef, index, bitValue);
                }
                return;
            }
            // Skip already-nonzero coefficients (appending correction bits) and `run`
            // still-zero ones; the new coefficient lands where the run ends.
            while (k <= se) {
                const index = base + ZIGZAG[k];
                if (coef[index] !== 0) {
                    correctCoefficient(reader, coef, index, bitValue);
                }
                else if (--run < 0) {
                    break;
                }
                k++;
            }
            if (value !== 0) {
                if (k > se)
                    break;
                coef[base + ZIGZAG[k]] = value;
            }
            k++;
        }
    };
    let mcu = 0;
    while (mcu < total) {
        if (reader.marker >= 0) {
            if (reader.marker >= 0xd0 && reader.marker <= 0xd7) {
                reader.skipRestart();
                for (const component of frame.components)
                    component.predictor = 0;
                eobrun = 0;
            }
            else {
                break;
            }
        }
        const limit = restartInterval > 0 ? Math.min(total, mcu + restartInterval) : total;
        while (mcu < limit) {
            if (single) {
                const component = components[0];
                const row = Math.floor(mcu / mcuColumns);
                const column = mcu - row * mcuColumns;
                decodeBlock(component, row * component.stride + column);
            }
            else {
                const mcuRow = Math.floor(mcu / frame.mcusPerLine);
                const mcuColumn = mcu - mcuRow * frame.mcusPerLine;
                for (const component of components) {
                    for (let v = 0; v < component.v; v++) {
                        const blockRow = mcuRow * component.v + v;
                        for (let h = 0; h < component.h; h++) {
                            const blockColumn = mcuColumn * component.h + h;
                            decodeBlock(component, blockRow * component.stride + blockColumn);
                        }
                    }
                }
            }
            mcu++;
        }
        if (reader.marker >= 0 && !(reader.marker >= 0xd0 && reader.marker <= 0xd7))
            break;
    }
}
function idctBlock(coef, base, quant, out) {
    let allZero = true;
    for (let i = 1; i < 64; i++) {
        if (coef[base + i] !== 0) {
            allZero = false;
            break;
        }
    }
    if (allZero) {
        const value = (coef[base] * quant[0]) / 8 + 128;
        const sample = value < 0 ? 0 : value > 255 ? 255 : Math.round(value);
        for (let i = 0; i < 64; i++)
            out[i] = sample;
        return;
    }
    for (let i = 0; i < 64; i++)
        SCRATCH_SOURCE[i] = coef[base + i] * quant[i];
    for (let y = 0; y < 8; y++) {
        const row = y * 8;
        for (let x = 0; x < 8; x++) {
            let sum = 0;
            for (let u = 0; u < 8; u++)
                sum += IDCT_BASIS[x * 8 + u] * SCRATCH_SOURCE[row + u];
            SCRATCH_MID[row + x] = sum;
        }
    }
    for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
            let sum = 0;
            for (let v = 0; v < 8; v++)
                sum += SCRATCH_MID[v * 8 + x] * IDCT_BASIS[y * 8 + v];
            const value = sum + 128;
            out[y * 8 + x] = value < 0 ? 0 : value > 255 ? 255 : Math.round(value);
        }
    }
}
/** Walk the marker list to the first EXIF APP1 segment and read tag 0x0112. */
function exifOrientation(bytes) {
    let pos = 2;
    while (pos + 4 <= bytes.length) {
        if (bytes[pos] !== 0xff) {
            pos++;
            continue;
        }
        const marker = bytes[pos + 1];
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
            pos += 2;
            continue;
        }
        if (marker === 0xd9 || marker === 0xda)
            break;
        const length = readUint16(bytes, pos + 2);
        if (marker === 0xe1) {
            const start = pos + 4;
            const end = Math.min(pos + 2 + length, bytes.length);
            const isExif = end > start + 8
                && bytes[start] === 0x45 && bytes[start + 1] === 0x78
                && bytes[start + 2] === 0x69 && bytes[start + 3] === 0x66;
            if (isExif) {
                const tiff = start + 6;
                const little = bytes[tiff] === 0x49 && bytes[tiff + 1] === 0x49;
                const big = bytes[tiff] === 0x4d && bytes[tiff + 1] === 0x4d;
                if (little || big) {
                    const u16 = (at) => (little ? bytes[at] | (bytes[at + 1] << 8) : (bytes[at] << 8) | bytes[at + 1]);
                    const u32 = (at) => (little
                        ? ((bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0)
                        : (((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0));
                    const ifd = tiff + u32(tiff + 4);
                    if (ifd + 2 <= end) {
                        const entries = u16(ifd);
                        for (let i = 0; i < entries; i++) {
                            const entry = ifd + 2 + i * 12;
                            if (entry + 12 > end)
                                break;
                            if (u16(entry) === 0x0112) {
                                const value = u16(entry + 8);
                                if (value >= 1 && value <= 8)
                                    return value;
                            }
                        }
                    }
                }
            }
        }
        pos += 2 + length;
    }
    return 1;
}
/** EXIF orientation (1..8) of a JPEG file, 1 when absent. */
export function jpegOrientation(bytes) {
    return exifOrientation(bytes);
}
/** Image dimensions from the frame header, without decoding pixels (orientation applied). */
export function jpegDims(bytes) {
    let pos = 2;
    while (pos + 4 <= bytes.length) {
        if (bytes[pos] !== 0xff) {
            pos++;
            continue;
        }
        const marker = bytes[pos + 1];
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
            pos += 2;
            continue;
        }
        if (marker === 0xd9)
            break;
        const length = readUint16(bytes, pos + 2);
        if (isFrameMarker(marker)) {
            const height = readUint16(bytes, pos + 5);
            const width = readUint16(bytes, pos + 7);
            if (!width || !height)
                break;
            const swap = exifOrientation(bytes) >= 5;
            return swap ? { width: height, height: width } : { width, height };
        }
        pos += 2 + length;
    }
    throw new JpegError('cannot read JPEG dimensions');
}
function applyOrientation(image, orientation) {
    if (orientation < 2 || orientation > 8)
        return image;
    const { width, height, data } = image;
    const swap = orientation >= 5;
    const targetWidth = swap ? height : width;
    const targetHeight = swap ? width : height;
    const out = new Uint8Array(targetWidth * targetHeight * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            let tx;
            let ty;
            switch (orientation) {
                case 2:
                    tx = width - 1 - x;
                    ty = y;
                    break;
                case 3:
                    tx = width - 1 - x;
                    ty = height - 1 - y;
                    break;
                case 4:
                    tx = x;
                    ty = height - 1 - y;
                    break;
                case 5:
                    tx = y;
                    ty = x;
                    break;
                case 6:
                    tx = height - 1 - y;
                    ty = x;
                    break;
                case 7:
                    tx = height - 1 - y;
                    ty = width - 1 - x;
                    break;
                default:
                    tx = y;
                    ty = width - 1 - x;
                    break;
            }
            const source = (y * width + x) * 4;
            const target = (ty * targetWidth + tx) * 4;
            out[target] = data[source];
            out[target + 1] = data[source + 1];
            out[target + 2] = data[source + 2];
            out[target + 3] = data[source + 3];
        }
    }
    return { width: targetWidth, height: targetHeight, data: out };
}
/** Decode a JPEG file into RGBA (EXIF orientation applied). */
export function decodeJpeg(bytes) {
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff)
        throw new JpegError('not a JPEG file');
    const quantTables = [];
    const dcTables = [];
    const acTables = [];
    let frame = null;
    let restartInterval = 0;
    let pos = 2;
    while (pos + 3 < bytes.length) {
        if (bytes[pos] !== 0xff) {
            pos++;
            continue;
        }
        let marker = bytes[pos + 1];
        while (marker === 0xff) {
            pos++;
            marker = bytes[pos + 1];
        }
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
            pos += 2;
            continue;
        }
        if (marker === 0xd9)
            break;
        if (marker === 0xda) {
            if (!frame)
                throw new JpegError('JPEG scan appears before its frame header');
            const length = readUint16(bytes, pos + 2);
            const headerEnd = pos + 2 + length;
            if (headerEnd > bytes.length)
                break;
            const count = bytes[pos + 4];
            const scanComponents = [];
            for (let i = 0; i < count; i++) {
                const entry = pos + 5 + i * 2;
                if (entry + 1 >= bytes.length)
                    break;
                const id = bytes[entry];
                const tables = bytes[entry + 1];
                const component = frame.components.find((candidate) => candidate.id === id);
                if (!component)
                    throw new JpegError('JPEG scan references an unknown component');
                component.dcTable = dcTables[tables >> 4] ?? null;
                component.acTable = acTables[tables & 15] ?? null;
                scanComponents.push(component);
            }
            const tail = pos + 5 + count * 2;
            if (tail + 2 >= bytes.length)
                break;
            decodeScan(bytes, headerEnd, frame, scanComponents, restartInterval, bytes[tail], bytes[tail + 1], bytes[tail + 2] >> 4, bytes[tail + 2] & 15);
            pos = headerEnd;
            // Skip entropy-coded data up to the next real marker.
            while (pos + 1 < bytes.length) {
                if (bytes[pos] !== 0xff) {
                    pos++;
                    continue;
                }
                const next = bytes[pos + 1];
                if (next === 0xff) {
                    pos++;
                    continue;
                }
                if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) {
                    pos += 2;
                    continue;
                }
                break;
            }
            continue;
        }
        const length = readUint16(bytes, pos + 2);
        if (length < 2)
            break;
        const start = pos + 4;
        const end = pos + 2 + length;
        if (end > bytes.length)
            break;
        if (marker === 0xdb) {
            let p = start;
            while (p < end) {
                const info = bytes[p++];
                const precision = info >> 4;
                const index = info & 15;
                const table = new Int32Array(64);
                for (let k = 0; k < 64; k++) {
                    table[ZIGZAG[k]] = precision ? readUint16(bytes, p + k * 2) : bytes[p + k];
                }
                p += precision ? 128 : 64;
                quantTables[index] = table;
            }
        }
        else if (marker === 0xc4) {
            let p = start;
            while (p < end) {
                const info = bytes[p++];
                const tableClass = info >> 4;
                const index = info & 15;
                const counts = [];
                let total = 0;
                for (let i = 0; i < 16; i++) {
                    counts.push(bytes[p + i]);
                    total += bytes[p + i];
                }
                p += 16;
                const symbols = bytes.subarray(p, p + total);
                p += total;
                const table = new HuffTable({ counts, symbols });
                if (tableClass === 0)
                    dcTables[index] = table;
                else
                    acTables[index] = table;
            }
        }
        else if (isFrameMarker(marker)) {
            frame = parseFrame(bytes, marker, start);
        }
        else if (marker === 0xdd) {
            restartInterval = readUint16(bytes, start);
        }
        pos = end;
    }
    if (!frame)
        throw new JpegError('JPEG has no frame header');
    return applyOrientation(renderFrame(frame, quantTables), exifOrientation(bytes));
}
function renderFrame(frame, quantTables) {
    const planes = frame.components.map((component) => {
        const quant = quantTables[component.quantTable];
        if (!quant)
            throw new JpegError(`JPEG references a missing quantization table ${component.quantTable}`);
        const plane = new Uint8Array(component.sampleWidth * component.sampleHeight);
        const block = new Float64Array(64);
        for (let by = 0; by < component.blocksPerColumn; by++) {
            for (let bx = 0; bx < component.blocksPerLine; bx++) {
                idctBlock(component.coef, (by * component.stride + bx) * 64, quant, block);
                const rowStart = by * 8;
                const columnStart = bx * 8;
                for (let y = 0; y < 8; y++) {
                    const py = rowStart + y;
                    if (py >= component.sampleHeight)
                        break;
                    const target = py * component.sampleWidth;
                    for (let x = 0; x < 8; x++) {
                        const px = columnStart + x;
                        if (px >= component.sampleWidth)
                            break;
                        plane[target + px] = block[y * 8 + x];
                    }
                }
            }
        }
        return { plane, width: component.sampleWidth, height: component.sampleHeight };
    });
    const { width, height } = frame;
    const data = new Uint8Array(width * height * 4);
    // Upsampling: components at full resolution are used as-is; a component
    // subsampled exactly 2x gets libjpeg's triangle ("fancy") filter, which
    // removes the colour fringing plain pixel replication leaves at edges;
    // anything else falls back to nearest-neighbour.
    const surfaces = planes.map((surface) => expandPlane(surface, width, height));
    if (surfaces.length === 1) {
        const pixels = surfaces[0];
        for (let i = 0; i < width * height; i++) {
            const value = pixels[i];
            const target = i * 4;
            data[target] = value;
            data[target + 1] = value;
            data[target + 2] = value;
            data[target + 3] = 255;
        }
        return { width, height, data };
    }
    const [luma, blue, red] = surfaces;
    for (let i = 0; i < width * height; i++) {
        const l = luma[i];
        const cb = blue[i] - 128;
        const cr = red[i] - 128;
        const r = l + 1.402 * cr;
        const g = l - 0.344136 * cb - 0.714136 * cr;
        const b = l + 1.772 * cb;
        const target = i * 4;
        data[target] = r < 0 ? 0 : r > 255 ? 255 : Math.round(r);
        data[target + 1] = g < 0 ? 0 : g > 255 ? 255 : Math.round(g);
        data[target + 2] = b < 0 ? 0 : b > 255 ? 255 : Math.round(b);
        data[target + 3] = 255;
    }
    return { width, height, data };
}
/** Nearest-neighbour expansion, used when the sampling ratio is not exactly 2. */
function expandNearest(plane, planeWidth, planeHeight, width, height) {
    const out = new Uint8Array(width * height);
    const columns = new Int32Array(width);
    for (let x = 0; x < width; x++)
        columns[x] = Math.min(planeWidth - 1, Math.floor((x * planeWidth) / width));
    for (let y = 0; y < height; y++) {
        const source = Math.min(planeHeight - 1, Math.floor((y * planeHeight) / height)) * planeWidth;
        const target = y * width;
        for (let x = 0; x < width; x++)
            out[target + x] = plane[source + columns[x]];
    }
    return out;
}
/** Triangle-filter doubling of one line, exactly as libjpeg's h2v1 fancy pass. */
function fancyLine(line, lineWidth, target, out) {
    if (lineWidth === 1) {
        out[target] = line[0];
        out[target + 1] = line[0];
        return;
    }
    out[target] = line[0];
    out[target + 1] = (3 * line[0] + line[1] + 2) >> 2;
    for (let x = 1; x < lineWidth - 1; x++) {
        const current = 3 * line[x];
        out[target + x * 2] = (current + line[x - 1] + 1) >> 2;
        out[target + x * 2 + 1] = (current + line[x + 1] + 2) >> 2;
    }
    const last = lineWidth - 1;
    out[target + last * 2] = (3 * line[last] + line[last - 1] + 1) >> 2;
    out[target + last * 2 + 1] = line[last];
}
/** Expand one component plane to the full image size. */
function expandPlane(surface, width, height) {
    const { plane, width: planeWidth, height: planeHeight } = surface;
    if (planeWidth === width && planeHeight === height)
        return plane;
    // Odd image sizes leave a half-pixel row or column, so a doubled plane may be
    // one pixel wider/taller than the image; the extra edge is simply dropped.
    const doubledWidth = planeWidth * 2;
    const doubledHeight = planeHeight * 2;
    const fits = (doubledWidth === width || doubledWidth === width + 1)
        && (doubledHeight === height || doubledHeight === height + 1);
    if (!fits)
        return expandNearest(plane, planeWidth, planeHeight, width, height);
    // Vertical triangle filter into a half-width row, then the horizontal one.
    const out = new Uint8Array(width * height);
    const blended = new Uint8Array(planeWidth);
    const line = new Uint8Array(doubledWidth);
    const columns = Math.min(width, doubledWidth);
    for (let y = 0; y < height; y++) {
        const row = y >> 1;
        const other = y & 1 ? Math.min(planeHeight - 1, row + 1) : Math.max(0, row - 1);
        const rowBase = row * planeWidth;
        const otherBase = other * planeWidth;
        for (let x = 0; x < planeWidth; x++) {
            blended[x] = (3 * plane[rowBase + x] + plane[otherBase + x] + 2) >> 2;
        }
        fancyLine(blended, planeWidth, 0, line);
        out.set(line.subarray(0, columns), y * width);
    }
    return out;
}
