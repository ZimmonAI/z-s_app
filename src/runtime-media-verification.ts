import { open, readFile } from 'node:fs/promises';
import type {
  VerifiedMediaMetadata,
  VerifiedVideoMetadata,
} from './runtime-contract.js';


export type MediaVerificationErrorCode =
  | 'media-source-invalid'
  | 'media-source-too-large'
  | 'media-type-unsupported'
  | 'media-type-mismatch'
  | 'png-malformed'
  | 'png-dimensions-invalid'
  | 'png-pixel-limit-exceeded'
  | 'mp4-malformed'
  | 'mp4-container-unsupported'
  | 'mp4-timing-missing'
  | 'mp4-duration-invalid'
  | 'mp4-traversal-limit-exceeded';

export class MediaVerificationError extends Error {
  readonly category = 'invalid-request' as const;
  readonly status = 415;
  readonly retryable = false;
  readonly code: MediaVerificationErrorCode;

  constructor(code: MediaVerificationErrorCode) {
    super(code);
    this.name = 'MediaVerificationError';
    this.code = code;
  }
}

export type MediaVerificationSource =
  | Uint8Array
  | Readonly<{ filePath: string }>;

export interface MediaVerificationInput {
  declaredMediaType: string;
  source: MediaVerificationSource;
  maximumByteLength?: number;
}

export interface MediaVerificationAdapter {
  verify(input: Readonly<MediaVerificationInput>): Promise<Readonly<VerifiedMediaMetadata>>;
}

export interface BoundedMediaVerifierOptions {
  maximumByteLength?: number;
  maximumImagePixels?: number;
  maximumMp4Boxes?: number;
  maximumMp4Depth?: number;
}

const PNG_SIGNATURE = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
const SUPPORTED_MP4_BRANDS = new Set(['isom', 'iso2', 'mp41', 'mp42', 'avc1', 'M4V ']);

function fail(code: MediaVerificationErrorCode): never {
  throw new MediaVerificationError(code);
}

function equalBytes(bytes: Uint8Array, offset: number, expected: Uint8Array): boolean {
  if (offset < 0 || offset + expected.byteLength > bytes.byteLength) return false;
  return expected.every((value, index) => bytes[offset + index] === value);
}

function readU16(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 2 > bytes.byteLength) fail('mp4-malformed');
  return (bytes[offset]! << 8) | bytes[offset + 1]!;
}

function readU32(bytes: Uint8Array, offset: number, code: MediaVerificationErrorCode): number {
  if (offset < 0 || offset + 4 > bytes.byteLength) fail(code);
  return (
    bytes[offset]! * 0x1000000 +
    bytes[offset + 1]! * 0x10000 +
    bytes[offset + 2]! * 0x100 +
    bytes[offset + 3]!
  );
}

function readU64(bytes: Uint8Array, offset: number): bigint {
  if (offset < 0 || offset + 8 > bytes.byteLength) fail('mp4-malformed');
  let value = 0n;
  for (let index = 0; index < 8; index += 1) {
    value = (value << 8n) | BigInt(bytes[offset + index]!);
  }
  return value;
}

function readFourCc(bytes: Uint8Array, offset: number): string {
  if (offset < 0 || offset + 4 > bytes.byteLength) fail('mp4-malformed');
  let value = '';
  for (let index = 0; index < 4; index += 1) {
    const code = bytes[offset + index]!;
    if (code < 0x20 || code > 0x7e) fail('mp4-malformed');
    value += String.fromCharCode(code);
  }
  return value;
}

async function boundedBytes(
  source: MediaVerificationSource,
  maximumByteLength: number,
): Promise<Uint8Array> {
  if (source instanceof Uint8Array) {
    if (source.byteLength === 0) fail('media-source-invalid');
    if (source.byteLength > maximumByteLength) fail('media-source-too-large');
    return source;
  }
  if (
    typeof source !== 'object' ||
    source === null ||
    typeof source.filePath !== 'string' ||
    source.filePath.length === 0
  ) {
    fail('media-source-invalid');
  }
  const handle = await open(source.filePath, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size <= 0) fail('media-source-invalid');
    if (stat.size > maximumByteLength) fail('media-source-too-large');
  } finally {
    await handle.close();
  }
  return readFile(source.filePath);
}

function verifyPng(bytes: Uint8Array, maximumImagePixels: number): Readonly<VerifiedMediaMetadata> {
  if (!equalBytes(bytes, 0, PNG_SIGNATURE)) fail('png-malformed');
  let offset = PNG_SIGNATURE.byteLength;
  let chunks = 0;
  let width: number | undefined;
  let height: number | undefined;
  let sawIend = false;

  while (offset < bytes.byteLength) {
    chunks += 1;
    if (chunks > 4096) fail('png-malformed');
    if (offset + 12 > bytes.byteLength) fail('png-malformed');
    const length = readU32(bytes, offset, 'png-malformed');
    const typeOffset = offset + 4;
    const dataOffset = offset + 8;
    const next = dataOffset + length + 4;
    if (!Number.isSafeInteger(next) || next > bytes.byteLength) fail('png-malformed');
    const type = String.fromCharCode(
      bytes[typeOffset]!,
      bytes[typeOffset + 1]!,
      bytes[typeOffset + 2]!,
      bytes[typeOffset + 3]!,
    );
    if (!/^[A-Za-z]{4}$/.test(type)) fail('png-malformed');

    if (chunks === 1) {
      if (type !== 'IHDR' || length !== 13) fail('png-malformed');
      width = readU32(bytes, dataOffset, 'png-malformed');
      height = readU32(bytes, dataOffset + 4, 'png-malformed');
      if (width <= 0 || height <= 0) fail('png-dimensions-invalid');
      const pixels = BigInt(width) * BigInt(height);
      if (pixels > BigInt(maximumImagePixels)) fail('png-pixel-limit-exceeded');
    } else if (type === 'IHDR') {
      fail('png-malformed');
    }

    if (type === 'IEND') {
      if (length !== 0 || next !== bytes.byteLength) fail('png-malformed');
      sawIend = true;
      offset = next;
      break;
    }
    offset = next;
  }

  if (!sawIend || width === undefined || height === undefined || offset !== bytes.byteLength) {
    fail('png-malformed');
  }
  return Object.freeze({
    mediaType: 'image/png',
    mediaFamily: 'image',
    image: Object.freeze({ width, height }),
  });
}

interface Mp4Box {
  type: string;
  start: number;
  payloadStart: number;
  end: number;
}

interface Mp4TraversalState {
  count: number;
  maximumBoxes: number;
  maximumDepth: number;
}

function nextMp4Box(
  bytes: Uint8Array,
  offset: number,
  end: number,
  state: Mp4TraversalState,
): Mp4Box {
  state.count += 1;
  if (state.count > state.maximumBoxes) fail('mp4-traversal-limit-exceeded');
  if (offset + 8 > end) fail('mp4-malformed');
  const size32 = readU32(bytes, offset, 'mp4-malformed');
  const type = readFourCc(bytes, offset + 4);
  let headerLength = 8;
  let size: number;
  if (size32 === 1) {
    const value = readU64(bytes, offset + 8);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) fail('mp4-malformed');
    size = Number(value);
    headerLength = 16;
  } else if (size32 === 0) {
    size = end - offset;
  } else {
    size = size32;
  }
  if (size < headerLength || offset + size > end || !Number.isSafeInteger(offset + size)) {
    fail('mp4-malformed');
  }
  return { type, start: offset, payloadStart: offset + headerLength, end: offset + size };
}

function parseMovieHeader(bytes: Uint8Array, box: Mp4Box): number {
  const version = bytes[box.payloadStart];
  if (version === undefined) fail('mp4-malformed');
  let timescale: number;
  let duration: bigint;
  if (version === 0) {
    timescale = readU32(bytes, box.payloadStart + 12, 'mp4-malformed');
    duration = BigInt(readU32(bytes, box.payloadStart + 16, 'mp4-malformed'));
  } else if (version === 1) {
    timescale = readU32(bytes, box.payloadStart + 20, 'mp4-malformed');
    duration = readU64(bytes, box.payloadStart + 24);
  } else {
    fail('mp4-malformed');
  }
  if (timescale <= 0 || duration <= 0n) fail('mp4-duration-invalid');
  const milliseconds = (duration * 1000n + BigInt(timescale / 2)) / BigInt(timescale);
  if (milliseconds <= 0n || milliseconds > BigInt(Number.MAX_SAFE_INTEGER)) {
    fail('mp4-duration-invalid');
  }
  return Number(milliseconds);
}

function parseTrackHeader(bytes: Uint8Array, box: Mp4Box): { width?: number; height?: number } {
  if (box.end - box.payloadStart < 12) fail('mp4-malformed');
  const widthFixed = readU32(bytes, box.end - 8, 'mp4-malformed');
  const heightFixed = readU32(bytes, box.end - 4, 'mp4-malformed');
  const width = Math.floor(widthFixed / 65536);
  const height = Math.floor(heightFixed / 65536);
  if (width <= 0 || height <= 0) return {};
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)) fail('mp4-malformed');
  return { width, height };
}

function parseSampleDescription(bytes: Uint8Array, box: Mp4Box): { codec?: string; width?: number; height?: number } {
  if (box.payloadStart + 8 > box.end) fail('mp4-malformed');
  const entryCount = readU32(bytes, box.payloadStart + 4, 'mp4-malformed');
  if (entryCount < 1) return {};
  const entryStart = box.payloadStart + 8;
  const entrySize = readU32(bytes, entryStart, 'mp4-malformed');
  if (entrySize < 8 || entryStart + entrySize > box.end) fail('mp4-malformed');
  const codec = readFourCc(bytes, entryStart + 4);
  if (!SAFE_TOKEN.test(codec.trim())) fail('mp4-malformed');
  const result: { codec?: string; width?: number; height?: number } = { codec: codec.trim() };
  if (entrySize >= 36) {
    const width = readU16(bytes, entryStart + 32);
    const height = readU16(bytes, entryStart + 34);
    if (width > 0 && height > 0) {
      result.width = width;
      result.height = height;
    }
  }
  return result;
}

function findSampleDescription(
  bytes: Uint8Array,
  start: number,
  end: number,
  depth: number,
  state: Mp4TraversalState,
): { codec?: string; width?: number; height?: number } {
  if (depth > state.maximumDepth) fail('mp4-traversal-limit-exceeded');
  let offset = start;
  while (offset < end) {
    const box = nextMp4Box(bytes, offset, end, state);
    if (box.type === 'stsd') return parseSampleDescription(bytes, box);
    if (box.type === 'mdia' || box.type === 'minf' || box.type === 'stbl') {
      const nested = findSampleDescription(bytes, box.payloadStart, box.end, depth + 1, state);
      if (nested.codec !== undefined) return nested;
    }
    offset = box.end;
  }
  if (offset !== end) fail('mp4-malformed');
  return {};
}

function parseTrack(
  bytes: Uint8Array,
  box: Mp4Box,
  depth: number,
  state: Mp4TraversalState,
): { video: boolean; codec?: string; width?: number; height?: number } {
  if (depth > state.maximumDepth) fail('mp4-traversal-limit-exceeded');
  let offset = box.payloadStart;
  let video = false;
  let headerDimensions: { width?: number; height?: number } = {};
  let sample: { codec?: string; width?: number; height?: number } = {};
  while (offset < box.end) {
    const child = nextMp4Box(bytes, offset, box.end, state);
    if (child.type === 'tkhd') headerDimensions = parseTrackHeader(bytes, child);
    if (child.type === 'mdia') {
      let mdiaOffset = child.payloadStart;
      while (mdiaOffset < child.end) {
        const mdiaChild = nextMp4Box(bytes, mdiaOffset, child.end, state);
        if (mdiaChild.type === 'hdlr') {
          if (mdiaChild.payloadStart + 12 > mdiaChild.end) fail('mp4-malformed');
          video = readFourCc(bytes, mdiaChild.payloadStart + 8) === 'vide';
        }
        if (mdiaChild.type === 'minf') {
          sample = findSampleDescription(
            bytes,
            mdiaChild.payloadStart,
            mdiaChild.end,
            depth + 2,
            state,
          );
        }
        mdiaOffset = mdiaChild.end;
      }
    }
    offset = child.end;
  }
  const result: { video: boolean; codec?: string; width?: number; height?: number } = { video };
  if (video) {
    const width = sample.width ?? headerDimensions.width;
    const height = sample.height ?? headerDimensions.height;
    if (width !== undefined) result.width = width;
    if (height !== undefined) result.height = height;
    if (sample.codec !== undefined) result.codec = sample.codec;
  }
  return result;
}

function verifyMp4(
  bytes: Uint8Array,
  maximumBoxes: number,
  maximumDepth: number,
): Readonly<VerifiedMediaMetadata> {
  const state: Mp4TraversalState = { count: 0, maximumBoxes, maximumDepth };
  let offset = 0;
  let sawFtyp = false;
  let durationMs: number | undefined;
  let video: { codec?: string; width?: number; height?: number } = {};

  while (offset < bytes.byteLength) {
    const box = nextMp4Box(bytes, offset, bytes.byteLength, state);
    if (offset === 0 && box.type !== 'ftyp') fail('mp4-container-unsupported');
    if (box.type === 'ftyp') {
      if (sawFtyp || box.payloadStart + 8 > box.end) fail('mp4-malformed');
      const brands: string[] = [readFourCc(bytes, box.payloadStart)];
      for (let brandOffset = box.payloadStart + 8; brandOffset + 4 <= box.end; brandOffset += 4) {
        brands.push(readFourCc(bytes, brandOffset));
      }
      if (!brands.some((brand) => SUPPORTED_MP4_BRANDS.has(brand))) {
        fail('mp4-container-unsupported');
      }
      sawFtyp = true;
    }
    if (box.type === 'moov') {
      let moovOffset = box.payloadStart;
      while (moovOffset < box.end) {
        const child = nextMp4Box(bytes, moovOffset, box.end, state);
        if (child.type === 'mvhd') durationMs = parseMovieHeader(bytes, child);
        if (child.type === 'trak') {
          const track = parseTrack(bytes, child, 1, state);
          if (track.video) {
            video = {};
            if (track.width !== undefined) video.width = track.width;
            if (track.height !== undefined) video.height = track.height;
            if (track.codec !== undefined) video.codec = track.codec;
          }
        }
        moovOffset = child.end;
      }
    }
    offset = box.end;
  }

  if (!sawFtyp) fail('mp4-container-unsupported');
  if (durationMs === undefined) fail('mp4-timing-missing');
  const verifiedVideo: VerifiedVideoMetadata = { durationMs, container: 'mp4' };
  if (video.width !== undefined) verifiedVideo.width = video.width;
  if (video.height !== undefined) verifiedVideo.height = video.height;
  if (video.codec !== undefined) verifiedVideo.codec = video.codec;
  return Object.freeze({
    mediaType: 'video/mp4',
    mediaFamily: 'video',
    video: Object.freeze(verifiedVideo),
  });
}

export class BoundedMediaVerifier implements MediaVerificationAdapter {
  private readonly maximumByteLength: number;
  private readonly maximumImagePixels: number;
  private readonly maximumMp4Boxes: number;
  private readonly maximumMp4Depth: number;

  constructor(options: BoundedMediaVerifierOptions = {}) {
    this.maximumByteLength = options.maximumByteLength ?? 32 * 1024 * 1024;
    this.maximumImagePixels = options.maximumImagePixels ?? 100_000_000;
    this.maximumMp4Boxes = options.maximumMp4Boxes ?? 4096;
    this.maximumMp4Depth = options.maximumMp4Depth ?? 8;
    if (
      !Number.isSafeInteger(this.maximumByteLength) ||
      this.maximumByteLength <= 0 ||
      !Number.isSafeInteger(this.maximumImagePixels) ||
      this.maximumImagePixels <= 0 ||
      !Number.isSafeInteger(this.maximumMp4Boxes) ||
      this.maximumMp4Boxes <= 0 ||
      !Number.isSafeInteger(this.maximumMp4Depth) ||
      this.maximumMp4Depth <= 0
    ) {
      throw new TypeError('invalid-media-verifier-limits');
    }
  }

  async verify(input: Readonly<MediaVerificationInput>): Promise<Readonly<VerifiedMediaMetadata>> {
    const maximum = input.maximumByteLength ?? this.maximumByteLength;
    if (!Number.isSafeInteger(maximum) || maximum <= 0 || maximum > this.maximumByteLength) {
      fail('media-source-too-large');
    }
    const bytes = await boundedBytes(input.source, maximum);
    let verified: Readonly<VerifiedMediaMetadata>;
    if (equalBytes(bytes, 0, PNG_SIGNATURE)) {
      verified = verifyPng(bytes, this.maximumImagePixels);
    } else if (bytes.byteLength >= 8 && readFourCc(bytes, 4) === 'ftyp') {
      verified = verifyMp4(bytes, this.maximumMp4Boxes, this.maximumMp4Depth);
    } else {
      fail('media-type-unsupported');
    }
    if (verified.mediaType !== input.declaredMediaType) fail('media-type-mismatch');
    return verified;
  }
}
