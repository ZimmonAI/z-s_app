import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BoundedMediaVerifier,
  MediaVerificationError,
} from '../src/runtime-media-verification.js';

function u32(value: number): Uint8Array {
  return Uint8Array.of(
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  );
}

function ascii(value: string): Uint8Array {
  return Uint8Array.from([...value].map((entry) => entry.charCodeAt(0)));
}

function join(...parts: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function png(width = 2, height = 3): Uint8Array {
  const signature = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
  const ihdrData = join(
    u32(width),
    u32(height),
    Uint8Array.of(8, 6, 0, 0, 0),
  );
  return join(
    signature,
    u32(ihdrData.byteLength),
    ascii('IHDR'),
    ihdrData,
    new Uint8Array(4),
    u32(0),
    ascii('IEND'),
    new Uint8Array(4),
  );
}

function box(type: string, payload: Uint8Array): Uint8Array {
  return join(u32(8 + payload.byteLength), ascii(type), payload);
}

function mp4(timescale = 1_000, duration = 2_000): Uint8Array {
  const ftyp = box('ftyp', join(ascii('isom'), u32(0), ascii('mp42')));
  const mvhdPayload = join(
    Uint8Array.of(0, 0, 0, 0),
    u32(0),
    u32(0),
    u32(timescale),
    u32(duration),
  );
  return join(ftyp, box('moov', box('mvhd', mvhdPayload)));
}

async function rejectsCode(operation: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(operation, (error: unknown) => {
    assert.ok(error instanceof MediaVerificationError);
    assert.equal(error.code, code);
    return true;
  });
}

test('verifies bounded PNG facts and rejects declared MIME mismatch', async () => {
  const verifier = new BoundedMediaVerifier({ maximumImagePixels: 100 });
  const result = await verifier.verify({
    declaredMediaType: 'image/png',
    source: png(2, 3),
  });
  assert.deepEqual(result, {
    mediaType: 'image/png',
    mediaFamily: 'image',
    image: { width: 2, height: 3 },
  });
  await rejectsCode(
    verifier.verify({ declaredMediaType: 'video/mp4', source: png(2, 3) }),
    'media-type-mismatch',
  );
});

test('rejects malformed and excessive PNG inputs deterministically', async () => {
  const verifier = new BoundedMediaVerifier({ maximumImagePixels: 4 });
  await rejectsCode(
    verifier.verify({ declaredMediaType: 'image/png', source: png(3, 2) }),
    'png-pixel-limit-exceeded',
  );
  const truncated = png().slice(0, -3);
  const permissive = new BoundedMediaVerifier({ maximumImagePixels: 100 });
  await rejectsCode(
    permissive.verify({ declaredMediaType: 'image/png', source: truncated }),
    'png-malformed',
  );
});

test('verifies deterministic MP4 timing without external executables', async () => {
  const verifier = new BoundedMediaVerifier();
  const result = await verifier.verify({
    declaredMediaType: 'video/mp4',
    source: mp4(1_000, 2_000),
  });
  assert.deepEqual(result, {
    mediaType: 'video/mp4',
    mediaFamily: 'video',
    video: { durationMs: 2_000, container: 'mp4' },
  });
});

test('rejects malformed, zero-duration and bounded-size MP4 inputs', async () => {
  const verifier = new BoundedMediaVerifier({ maximumByteLength: 128 });
  await rejectsCode(
    verifier.verify({ declaredMediaType: 'video/mp4', source: mp4(1_000, 0) }),
    'mp4-duration-invalid',
  );
  await rejectsCode(
    verifier.verify({ declaredMediaType: 'video/mp4', source: mp4().slice(0, -1) }),
    'mp4-malformed',
  );
  await rejectsCode(
    verifier.verify({
      declaredMediaType: 'video/mp4',
      source: mp4(),
      maximumByteLength: 8,
    }),
    'media-source-too-large',
  );
});
