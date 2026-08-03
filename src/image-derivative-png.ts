import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import {
  IMAGE_DERIVATIVE_LIMITS,
  ImageDerivativeError,
  type BoundedImageProcessor,
  type ImageDerivativeJob,
  type ImageDerivativeSource,
  type ProcessedImageDerivative,
} from './image-derivative.js';

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAXIMUM_CHUNKS = 4096;

interface DecodedPng {
  readonly width: number;
  readonly height: number;
  readonly channels: 3 | 4;
  readonly pixels: Uint8Array;
}

function readAll(source: Readonly<ImageDerivativeSource>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    source.body.on('data', (chunk: Buffer | Uint8Array | string) => {
      const value = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk);
      total += value.byteLength;
      if (total > IMAGE_DERIVATIVE_LIMITS.maximumSourceBytes) {
        source.body.destroy(new ImageDerivativeError(
          'invalid-request',
          'image-derivative-source-byte-limit',
        ));
        return;
      }
      chunks.push(value);
    });
    source.body.once('error', reject);
    source.body.once('end', () => resolve(Buffer.concat(chunks, total)));
  });
}

function paeth(left: number, above: number, upperLeft: number): number {
  const estimate = left + above - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const aboveDistance = Math.abs(estimate - above);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) return left;
  return aboveDistance <= upperLeftDistance ? above : upperLeft;
}

function decodePng(input: Buffer): DecodedPng {
  if (input.byteLength < 33 || !input.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new ImageDerivativeError('invalid-request', 'image-derivative-signature-mismatch');
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let channels: 3 | 4 | undefined;
  let sawHeader = false;
  let sawEnd = false;
  const compressed: Buffer[] = [];
  let chunkCount = 0;
  while (offset + 12 <= input.byteLength) {
    chunkCount += 1;
    if (chunkCount > MAXIMUM_CHUNKS) {
      throw new ImageDerivativeError('invalid-request', 'image-derivative-png-chunk-limit');
    }
    const length = input.readUInt32BE(offset);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const next = dataEnd + 4;
    if (length > IMAGE_DERIVATIVE_LIMITS.maximumSourceBytes || next > input.byteLength) {
      throw new ImageDerivativeError('invalid-request', 'image-derivative-png-truncated');
    }
    const type = input.toString('ascii', offset + 4, offset + 8);
    const data = input.subarray(dataStart, dataEnd);
    if (type === 'IHDR') {
      if (sawHeader || length !== 13) {
        throw new ImageDerivativeError('invalid-request', 'image-derivative-png-header-invalid');
      }
      sawHeader = true;
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const bitDepth = data[8];
      const colorType = data[9];
      const compression = data[10];
      const filter = data[11];
      const interlace = data[12];
      if (
        bitDepth !== 8 ||
        (colorType !== 2 && colorType !== 6) ||
        compression !== 0 ||
        filter !== 0 ||
        interlace !== 0
      ) {
        throw new ImageDerivativeError('invalid-request', 'image-derivative-png-mode-unsupported');
      }
      channels = colorType === 2 ? 3 : 4;
      if (
        width < 1 ||
        height < 1 ||
        width > IMAGE_DERIVATIVE_LIMITS.maximumWidth ||
        width * height > IMAGE_DERIVATIVE_LIMITS.maximumDecodedPixels
      ) {
        throw new ImageDerivativeError('invalid-request', 'image-derivative-pixel-limit');
      }
    } else if (type === 'IDAT') {
      if (!sawHeader) {
        throw new ImageDerivativeError('invalid-request', 'image-derivative-png-order-invalid');
      }
      compressed.push(data);
    } else if (type === 'IEND') {
      sawEnd = true;
      break;
    }
    offset = next;
  }

  if (!sawHeader || !sawEnd || channels === undefined || compressed.length === 0) {
    throw new ImageDerivativeError('invalid-request', 'image-derivative-png-truncated');
  }
  const stride = width * channels;
  const expected = height * (stride + 1);
  let inflated: Buffer;
  try {
    inflated = inflateSync(Buffer.concat(compressed), { maxOutputLength: expected });
  } catch {
    throw new ImageDerivativeError('invalid-request', 'image-derivative-png-inflate-failed');
  }
  if (inflated.byteLength !== expected) {
    throw new ImageDerivativeError('invalid-request', 'image-derivative-png-decoded-size-mismatch');
  }

  const pixels = Buffer.allocUnsafe(width * height * channels);
  for (let row = 0; row < height; row += 1) {
    const sourceOffset = row * (stride + 1);
    const filterType = inflated[sourceOffset];
    if (filterType === undefined || filterType > 4) {
      throw new ImageDerivativeError('invalid-request', 'image-derivative-png-filter-unsupported');
    }
    const targetOffset = row * stride;
    for (let index = 0; index < stride; index += 1) {
      const raw = inflated[sourceOffset + 1 + index] ?? 0;
      const left = index >= channels ? pixels[targetOffset + index - channels] ?? 0 : 0;
      const above = row > 0 ? pixels[targetOffset - stride + index] ?? 0 : 0;
      const upperLeft = row > 0 && index >= channels
        ? pixels[targetOffset - stride + index - channels] ?? 0
        : 0;
      let value = raw;
      if (filterType === 1) value = raw + left;
      else if (filterType === 2) value = raw + above;
      else if (filterType === 3) value = raw + Math.floor((left + above) / 2);
      else if (filterType === 4) value = raw + paeth(left, above, upperLeft);
      pixels[targetOffset + index] = value & 0xff;
    }
  }
  return Object.freeze({ width, height, channels, pixels });
}

function resize(input: Readonly<DecodedPng>, targetWidth: number): DecodedPng {
  const targetHeight = Math.max(1, Math.round((input.height * targetWidth) / input.width));
  if (targetWidth * targetHeight > IMAGE_DERIVATIVE_LIMITS.maximumDecodedPixels) {
    throw new ImageDerivativeError('invalid-request', 'image-derivative-output-pixel-limit');
  }
  const output = Buffer.allocUnsafe(targetWidth * targetHeight * input.channels);
  for (let y = 0; y < targetHeight; y += 1) {
    const sourceY = Math.min(input.height - 1, Math.floor((y * input.height) / targetHeight));
    for (let x = 0; x < targetWidth; x += 1) {
      const sourceX = Math.min(input.width - 1, Math.floor((x * input.width) / targetWidth));
      const sourceOffset = (sourceY * input.width + sourceX) * input.channels;
      const targetOffset = (y * targetWidth + x) * input.channels;
      for (let channel = 0; channel < input.channels; channel += 1) {
        output[targetOffset + channel] = input.pixels[sourceOffset + channel] ?? 0;
      }
    }
  }
  return Object.freeze({
    width: targetWidth,
    height: targetHeight,
    channels: input.channels,
    pixels: output,
  });
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(input: Buffer): number {
  let crc = 0xffffffff;
  for (const value of input) {
    crc = (CRC_TABLE[(crc ^ value) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, 'ascii');
  const result = Buffer.allocUnsafe(12 + data.byteLength);
  result.writeUInt32BE(data.byteLength, 0);
  typeBytes.copy(result, 4);
  data.copy(result, 8);
  result.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 8 + data.byteLength);
  return result;
}

function encodePng(input: Readonly<DecodedPng>, quality: number): Buffer {
  const stride = input.width * input.channels;
  const scanlines = Buffer.allocUnsafe(input.height * (stride + 1));
  for (let row = 0; row < input.height; row += 1) {
    const targetOffset = row * (stride + 1);
    scanlines[targetOffset] = 0;
    Buffer.from(input.pixels.buffer, input.pixels.byteOffset + row * stride, stride)
      .copy(scanlines, targetOffset + 1);
  }
  const header = Buffer.allocUnsafe(13);
  header.writeUInt32BE(input.width, 0);
  header.writeUInt32BE(input.height, 4);
  header[8] = 8;
  header[9] = input.channels === 3 ? 2 : 6;
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;
  const compressionLevel = Math.max(1, Math.min(9, Math.round(quality / 12)));
  const encoded = Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(scanlines, { level: compressionLevel })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  if (encoded.byteLength > IMAGE_DERIVATIVE_LIMITS.maximumOutputBytes) {
    throw new ImageDerivativeError('invalid-request', 'image-derivative-output-byte-limit');
  }
  return encoded;
}

export class PngImageDerivativeProcessor implements BoundedImageProcessor {
  async process(
    job: Readonly<ImageDerivativeJob>,
    source: Readonly<ImageDerivativeSource>,
  ): Promise<Readonly<ProcessedImageDerivative>> {
    if (source.mediaType !== 'image/png') {
      throw new ImageDerivativeError('invalid-request', 'image-derivative-input-mime-unsupported');
    }
    if (job.outputFormat !== 'png') {
      throw new ImageDerivativeError('not-ready', 'image-derivative-output-format-unsupported');
    }
    const bytes = await readAll(source);
    if (bytes.byteLength !== source.byteLength) {
      throw new ImageDerivativeError('invalid-request', 'image-derivative-source-length-mismatch');
    }
    if (createHash('sha256').update(bytes).digest('hex') !== source.checksumSha256) {
      throw new ImageDerivativeError('invalid-request', 'image-derivative-source-checksum-mismatch');
    }
    const decoded = decodePng(bytes);
    const resized = resize(decoded, job.requestedWidth);
    const encoded = encodePng(resized, job.quality);
    return Object.freeze({
      mediaType: 'image/png',
      width: resized.width,
      height: resized.height,
      byteLength: encoded.byteLength,
      checksumSha256: createHash('sha256').update(encoded).digest('hex'),
      body: encoded,
    });
  }
}
