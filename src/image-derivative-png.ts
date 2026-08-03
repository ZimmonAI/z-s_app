import { deflateSync, inflateSync } from 'node:zlib';
import {
  IMAGE_DERIVATIVE_LIMITS,
  ImageDerivativeError,
  type BoundedImageDerivativeInput,
  type BoundedImageDerivativeOutput,
  type BoundedImageDerivativeProcessor,
} from './image-derivative-contract.js';

interface ParsedPng {
  width: number;
  height: number;
  rgba: Uint8Array;
}

const PNG_SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let value = n;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[n] = value >>> 0;
  }
  return table;
})();

function invalidImage(code: string, status = 400): never {
  throw new ImageDerivativeError('invalid-request', code, status, false);
}

function requireBoundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  code: string,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) invalidImage(code);
  return value;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function readUint32(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 4 > bytes.byteLength) invalidImage('image-png-truncated');
  return (
    ((bytes[offset] ?? 0) * 0x1000000) +
    ((bytes[offset + 1] ?? 0) << 16) +
    ((bytes[offset + 2] ?? 0) << 8) +
    (bytes[offset + 3] ?? 0)
  ) >>> 0;
}

function writeUint32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  bytes[0] = (value >>> 24) & 0xff;
  bytes[1] = (value >>> 16) & 0xff;
  bytes[2] = (value >>> 8) & 0xff;
  bytes[3] = value & 0xff;
  return bytes;
}

function ascii(bytes: Uint8Array): string {
  return String.fromCharCode(...bytes);
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    const tableValue = CRC_TABLE[(crc ^ byte) & 0xff];
    if (tableValue === undefined) invalidImage('image-png-crc-internal');
    crc = tableValue ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = Uint8Array.from([...type].map((character) => character.charCodeAt(0)));
  const checksum = crc32(concatBytes([typeBytes, data]));
  return concatBytes([writeUint32(data.byteLength), typeBytes, data, writeUint32(checksum)]);
}

function paeth(left: number, above: number, upperLeft: number): number {
  const estimate = left + above - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const aboveDistance = Math.abs(estimate - above);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) return left;
  if (aboveDistance <= upperLeftDistance) return above;
  return upperLeft;
}

function unfilter(
  filtered: Uint8Array,
  width: number,
  height: number,
  bytesPerPixel: number,
): Uint8Array {
  const rowLength = width * bytesPerPixel;
  const expectedLength = height * (rowLength + 1);
  if (filtered.byteLength !== expectedLength) invalidImage('image-png-decoded-length-mismatch');
  const output = new Uint8Array(height * rowLength);
  for (let row = 0; row < height; row += 1) {
    const filteredOffset = row * (rowLength + 1);
    const filter = filtered[filteredOffset];
    if (filter === undefined || filter > 4) invalidImage('image-png-filter-unsupported');
    const outputOffset = row * rowLength;
    for (let column = 0; column < rowLength; column += 1) {
      const raw = filtered[filteredOffset + 1 + column] ?? 0;
      const left = column >= bytesPerPixel ? output[outputOffset + column - bytesPerPixel] ?? 0 : 0;
      const above = row > 0 ? output[outputOffset + column - rowLength] ?? 0 : 0;
      const upperLeft = row > 0 && column >= bytesPerPixel
        ? output[outputOffset + column - rowLength - bytesPerPixel] ?? 0
        : 0;
      const value = filter === 0
        ? raw
        : filter === 1
          ? raw + left
          : filter === 2
            ? raw + above
            : filter === 3
              ? raw + Math.floor((left + above) / 2)
              : raw + paeth(left, above, upperLeft);
      output[outputOffset + column] = value & 0xff;
    }
  }
  return output;
}

function toRgba(
  pixels: Uint8Array,
  width: number,
  height: number,
  colorType: number,
): Uint8Array {
  const output = new Uint8Array(width * height * 4);
  const pixelCount = width * height;
  for (let index = 0; index < pixelCount; index += 1) {
    const outputOffset = index * 4;
    if (colorType === 0) {
      const value = pixels[index] ?? 0;
      output[outputOffset] = value;
      output[outputOffset + 1] = value;
      output[outputOffset + 2] = value;
      output[outputOffset + 3] = 255;
    } else if (colorType === 2) {
      const inputOffset = index * 3;
      output[outputOffset] = pixels[inputOffset] ?? 0;
      output[outputOffset + 1] = pixels[inputOffset + 1] ?? 0;
      output[outputOffset + 2] = pixels[inputOffset + 2] ?? 0;
      output[outputOffset + 3] = 255;
    } else if (colorType === 4) {
      const inputOffset = index * 2;
      const value = pixels[inputOffset] ?? 0;
      output[outputOffset] = value;
      output[outputOffset + 1] = value;
      output[outputOffset + 2] = value;
      output[outputOffset + 3] = pixels[inputOffset + 1] ?? 0;
    } else if (colorType === 6) {
      const inputOffset = index * 4;
      output[outputOffset] = pixels[inputOffset] ?? 0;
      output[outputOffset + 1] = pixels[inputOffset + 1] ?? 0;
      output[outputOffset + 2] = pixels[inputOffset + 2] ?? 0;
      output[outputOffset + 3] = pixels[inputOffset + 3] ?? 0;
    } else {
      invalidImage('image-png-color-type-unsupported');
    }
  }
  return output;
}

function parsePng(bytes: Uint8Array): ParsedPng {
  if (bytes.byteLength > IMAGE_DERIVATIVE_LIMITS.maximumSourceByteLength) {
    invalidImage('image-source-byte-limit-exceeded', 413);
  }
  if (bytes.byteLength < PNG_SIGNATURE.byteLength || !bytesEqual(bytes.slice(0, 8), PNG_SIGNATURE)) {
    invalidImage('image-signature-mime-mismatch');
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = -1;
  let bytesPerPixel = 0;
  let sawHeader = false;
  let sawEnd = false;
  const idat: Uint8Array[] = [];
  while (offset < bytes.byteLength) {
    const length = readUint32(bytes, offset);
    const typeOffset = offset + 4;
    const dataOffset = offset + 8;
    const crcOffset = dataOffset + length;
    const endOffset = crcOffset + 4;
    if (length > IMAGE_DERIVATIVE_LIMITS.maximumSourceByteLength || endOffset > bytes.byteLength) {
      invalidImage('image-png-truncated');
    }
    const typeBytes = bytes.slice(typeOffset, dataOffset);
    const type = ascii(typeBytes);
    const data = bytes.slice(dataOffset, crcOffset);
    const expectedCrc = readUint32(bytes, crcOffset);
    if (crc32(concatBytes([typeBytes, data])) !== expectedCrc) invalidImage('image-png-crc-mismatch');
    if (!sawHeader && type !== 'IHDR') invalidImage('image-png-header-missing');
    if (type === 'IHDR') {
      if (sawHeader || data.byteLength !== 13) invalidImage('image-png-header-invalid');
      width = readUint32(data, 0);
      height = readUint32(data, 4);
      const bitDepth = data[8];
      colorType = data[9] ?? -1;
      const compression = data[10];
      const filter = data[11];
      const interlace = data[12];
      if (width < 1 || height < 1) invalidImage('image-png-dimensions-invalid');
      if (width * height > IMAGE_DERIVATIVE_LIMITS.maximumDecodedPixels) {
        invalidImage('image-decoded-pixel-limit-exceeded', 413);
      }
      if (bitDepth !== 8 || compression !== 0 || filter !== 0 || interlace !== 0) {
        invalidImage('image-png-encoding-unsupported');
      }
      bytesPerPixel = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 4 ? 2 : colorType === 6 ? 4 : 0;
      if (bytesPerPixel === 0) invalidImage('image-png-color-type-unsupported');
      sawHeader = true;
    } else if (type === 'IDAT') {
      if (!sawHeader || sawEnd) invalidImage('image-png-chunk-order-invalid');
      idat.push(data);
    } else if (type === 'IEND') {
      if (data.byteLength !== 0 || sawEnd) invalidImage('image-png-end-invalid');
      sawEnd = true;
      offset = endOffset;
      break;
    } else if (type === 'acTL') {
      invalidImage('image-animated-unsupported');
    } else if (/^[A-Z]/.test(type)) {
      invalidImage('image-png-critical-chunk-unsupported');
    }
    offset = endOffset;
  }
  if (!sawHeader || !sawEnd || offset !== bytes.byteLength || idat.length === 0) {
    invalidImage('image-png-structure-invalid');
  }
  let inflated: Uint8Array;
  try {
    inflated = inflateSync(concatBytes(idat), {
      maxOutputLength: Math.min(
        IMAGE_DERIVATIVE_LIMITS.maximumWorkingMemoryByteLength,
        height * (width * bytesPerPixel + 1),
      ),
    });
  } catch {
    invalidImage('image-png-compression-invalid');
  }
  const pixels = unfilter(inflated, width, height, bytesPerPixel);
  return { width, height, rgba: toRgba(pixels, width, height, colorType) };
}

function resizeNearest(source: ParsedPng, targetWidth: number): ParsedPng {
  const targetHeight = Math.max(1, Math.round((source.height * targetWidth) / source.width));
  if (targetWidth * targetHeight > IMAGE_DERIVATIVE_LIMITS.maximumDecodedPixels) {
    invalidImage('image-output-pixel-limit-exceeded', 413);
  }
  const requiredMemory = source.rgba.byteLength + targetWidth * targetHeight * 4;
  if (requiredMemory > IMAGE_DERIVATIVE_LIMITS.maximumWorkingMemoryByteLength) {
    invalidImage('image-working-memory-limit-exceeded', 413);
  }
  const output = new Uint8Array(targetWidth * targetHeight * 4);
  for (let y = 0; y < targetHeight; y += 1) {
    const sourceY = Math.min(source.height - 1, Math.floor((y * source.height) / targetHeight));
    for (let x = 0; x < targetWidth; x += 1) {
      const sourceX = Math.min(source.width - 1, Math.floor((x * source.width) / targetWidth));
      const sourceOffset = (sourceY * source.width + sourceX) * 4;
      const targetOffset = (y * targetWidth + x) * 4;
      output[targetOffset] = source.rgba[sourceOffset] ?? 0;
      output[targetOffset + 1] = source.rgba[sourceOffset + 1] ?? 0;
      output[targetOffset + 2] = source.rgba[sourceOffset + 2] ?? 0;
      output[targetOffset + 3] = source.rgba[sourceOffset + 3] ?? 0;
    }
  }
  return { width: targetWidth, height: targetHeight, rgba: output };
}

function encodePng(image: ParsedPng, quality: number): Uint8Array {
  const rowLength = image.width * 4;
  const filtered = new Uint8Array(image.height * (rowLength + 1));
  for (let row = 0; row < image.height; row += 1) {
    const targetOffset = row * (rowLength + 1);
    filtered[targetOffset] = 0;
    filtered.set(
      image.rgba.slice(row * rowLength, (row + 1) * rowLength),
      targetOffset + 1,
    );
  }
  const compressionLevel = Math.max(1, Math.min(9, Math.round((101 - quality) / 12)));
  const compressed = deflateSync(filtered, { level: compressionLevel });
  const header = new Uint8Array(13);
  header.set(writeUint32(image.width), 0);
  header.set(writeUint32(image.height), 4);
  header[8] = 8;
  header[9] = 6;
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;
  const encoded = concatBytes([
    PNG_SIGNATURE,
    pngChunk('IHDR', header),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', new Uint8Array()),
  ]);
  if (encoded.byteLength > IMAGE_DERIVATIVE_LIMITS.maximumOutputByteLength) {
    invalidImage('image-output-byte-limit-exceeded', 413);
  }
  return encoded;
}

export class BoundedPngImageDerivativeProcessor implements BoundedImageDerivativeProcessor {
  process(input: Readonly<BoundedImageDerivativeInput>): Readonly<BoundedImageDerivativeOutput> {
    if (input.declaredContentType !== 'image/png') invalidImage('image-input-mime-unsupported');
    if (input.outputFormat !== 'png') invalidImage('image-output-format-unsupported');
    requireBoundedInteger(
      input.width,
      IMAGE_DERIVATIVE_LIMITS.minimumWidth,
      IMAGE_DERIVATIVE_LIMITS.maximumWidth,
      'image-output-width-invalid',
    );
    requireBoundedInteger(
      input.quality,
      IMAGE_DERIVATIVE_LIMITS.minimumQuality,
      IMAGE_DERIVATIVE_LIMITS.maximumQuality,
      'image-output-quality-invalid',
    );
    if (!['inside', 'cover', 'contain', 'fill'].includes(input.fit)) {
      invalidImage('image-output-fit-invalid');
    }
    const source = parsePng(input.bytes);
    const resized = resizeNearest(source, input.width);
    return Object.freeze({
      bytes: encodePng(resized, input.quality),
      contentType: 'image/png',
      width: resized.width,
      height: resized.height,
    });
  }
}
