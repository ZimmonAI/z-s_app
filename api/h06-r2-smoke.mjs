import { createHash, randomUUID } from 'node:crypto';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

export const config = { maxDuration: 60 };

const BINDING_KEY = 'credential-binding:r2_video_maker_dev_01';
const BUCKET = 'video-maker-hot';

function safeError(error) {
  const rawMessage =
    error && typeof error === 'object' && typeof error.message === 'string'
      ? error.message
      : String(error);

  return {
    name:
      error && typeof error === 'object' && typeof error.name === 'string'
        ? error.name
        : null,
    code:
      error && typeof error === 'object' && typeof error.Code === 'string'
        ? error.Code
        : error && typeof error === 'object' && typeof error.code === 'string'
          ? error.code
          : null,
    status:
      error &&
      typeof error === 'object' &&
      error.$metadata &&
      typeof error.$metadata.httpStatusCode === 'number'
        ? error.$metadata.httpStatusCode
        : null,
    message: rawMessage
      .replace(/https?:\/\/[^\s]+/gi, '[redacted-url]')
      .replace(/video-maker-hot/gi, '[redacted-bucket]')
      .replace(/h06-vercel-r2-smoke\/[^\s]+/gi, '[redacted-object-key]')
      .slice(0, 240),
  };
}

async function bodyToBuffer(body) {
  if (!body) {
    return Buffer.alloc(0);
  }

  if (typeof body.transformToByteArray === 'function') {
    return Buffer.from(await body.transformToByteArray());
  }

  const chunks = [];
  for await (const chunk of body) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export default async function handler(request, response) {
  response.setHeader('cache-control', 'no-store');
  response.setHeader('content-type', 'application/json; charset=utf-8');

  if (request.method !== 'GET') {
    response.statusCode = 405;
    response.end(JSON.stringify({ error: 'method-not-allowed' }));
    return;
  }

  const result = {
    passed: false,
    bindingPresent: false,
    put: false,
    head: false,
    get: false,
    checksumMatches: false,
    delete: false,
    deleteVerified: false,
    failure: null,
  };

  let client = null;
  let objectKey = null;

  try {
    const rawBindings = process.env.Z_S_PROVIDER_CREDENTIAL_BINDINGS_JSON;
    if (!rawBindings) {
      throw new Error('provider-credential-bindings-missing');
    }

    const bindings = JSON.parse(rawBindings);
    const binding = bindings?.[BINDING_KEY];
    if (!binding || typeof binding !== 'object') {
      throw new Error('r2-binding-missing');
    }

    const endpoint = binding.endpoint;
    const region = binding.region;
    const accessKeyId = binding.accessKeyId;
    const secretAccessKey = binding['secretAccessKey'];
    const forcePathStyle = binding.forcePathStyle;

    if (
      typeof endpoint !== 'string' ||
      typeof region !== 'string' ||
      typeof accessKeyId !== 'string' ||
      typeof secretAccessKey !== 'string' ||
      typeof forcePathStyle !== 'boolean'
    ) {
      throw new Error('r2-binding-shape-invalid');
    }

    result.bindingPresent = true;

    client = new S3Client({
      endpoint,
      region,
      forcePathStyle,
      credentials: {
        accessKeyId,
        secretAccessKey,
      },
    });

    const bytes = Buffer.from(
      `h06-r2-smoke:${new Date().toISOString()}:${randomUUID()}`,
      'utf8',
    );
    const expectedChecksum = createHash('sha256').update(bytes).digest('hex');
    objectKey = `h06-vercel-r2-smoke/${randomUUID()}.txt`;

    await client.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: objectKey,
        Body: bytes,
        ContentType: 'text/plain',
      }),
    );
    result.put = true;

    const head = await client.send(
      new HeadObjectCommand({
        Bucket: BUCKET,
        Key: objectKey,
      }),
    );
    result.head = Number(head.ContentLength) === bytes.byteLength;

    const get = await client.send(
      new GetObjectCommand({
        Bucket: BUCKET,
        Key: objectKey,
      }),
    );
    const returned = await bodyToBuffer(get.Body);
    result.get = returned.byteLength === bytes.byteLength;
    result.checksumMatches =
      createHash('sha256').update(returned).digest('hex') === expectedChecksum;

    await client.send(
      new DeleteObjectCommand({
        Bucket: BUCKET,
        Key: objectKey,
      }),
    );
    result.delete = true;

    try {
      await client.send(
        new HeadObjectCommand({
          Bucket: BUCKET,
          Key: objectKey,
        }),
      );
      result.deleteVerified = false;
    } catch (error) {
      const status = error?.$metadata?.httpStatusCode;
      result.deleteVerified = status === 404;
    }

    result.passed =
      result.bindingPresent &&
      result.put &&
      result.head &&
      result.get &&
      result.checksumMatches &&
      result.delete &&
      result.deleteVerified;
  } catch (error) {
    result.failure = safeError(error);
  } finally {
    if (client && objectKey && !result.delete) {
      try {
        await client.send(
          new DeleteObjectCommand({
            Bucket: BUCKET,
            Key: objectKey,
          }),
        );
        result.delete = true;
      } catch (error) {
        result.failure ??= safeError(error);
      }
    }

    client?.destroy();
  }

  response.statusCode = result.passed ? 200 : 500;
  response.end(JSON.stringify(result));
}
