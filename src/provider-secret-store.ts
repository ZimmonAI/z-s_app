import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import type { ClientStorageEnvironment } from './client-storage-configuration.js';

export interface ProviderSecretContext {
  readonly clientId: string;
  readonly environment: ClientStorageEnvironment;
  readonly serviceId: string;
  readonly providerType: string;
}

export interface StoredProviderSecretEnvelope {
  readonly id: string;
  readonly keyVersion: number;
  readonly algorithm: 'aes-256-gcm';
  readonly nonce: Uint8Array;
  readonly ciphertext: Uint8Array;
  readonly authenticationTag: Uint8Array;
  readonly createdAt: string;
  readonly revokedAt?: string;
}

export interface ProviderSecretEnvelopeRepository {
  readonly configured: boolean;
  insert(
    context: Readonly<ProviderSecretContext>,
    envelope: Readonly<StoredProviderSecretEnvelope>,
  ): Promise<void>;
  read(
    context: Readonly<ProviderSecretContext>,
    secretId: string,
  ): Promise<Readonly<StoredProviderSecretEnvelope>>;
  revoke(
    context: Readonly<ProviderSecretContext>,
    secretId: string,
    replacedBySecretId: string | undefined,
    now: Date,
  ): Promise<void>;
}

export interface ProviderSecretStore {
  readonly configured: boolean;
  store(
    context: Readonly<ProviderSecretContext>,
    value: Readonly<Record<string, string>>,
    now?: Date,
  ): Promise<string>;
  resolve(
    context: Readonly<ProviderSecretContext>,
    secretId: string,
  ): Promise<Readonly<Record<string, string>>>;
  replace(
    context: Readonly<ProviderSecretContext>,
    previousSecretId: string,
    value: Readonly<Record<string, string>>,
    now?: Date,
  ): Promise<string>;
  revoke(
    context: Readonly<ProviderSecretContext>,
    secretId: string,
    now?: Date,
  ): Promise<void>;
}

export class ProviderSecretStoreError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(status: number, code: string) {
    super(code);
    this.name = 'ProviderSecretStoreError';
    this.status = status;
    this.code = code;
  }
}

export interface AesGcmProviderSecretStoreOptions {
  readonly repository: ProviderSecretEnvelopeRepository;
  readonly keys: ReadonlyMap<number, Uint8Array>;
  readonly activeKeyVersion: number;
}

const CONTEXT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SECRET_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9]{0,63}$/;

function associatedData(context: Readonly<ProviderSecretContext>): Buffer {
  for (const value of [
    context.clientId,
    context.environment,
    context.serviceId,
    context.providerType,
  ]) {
    if (!CONTEXT_PATTERN.test(value)) {
      throw new ProviderSecretStoreError(400, 'provider-secret-context-invalid');
    }
  }
  return Buffer.from(JSON.stringify({
    clientId: context.clientId,
    environment: context.environment,
    serviceId: context.serviceId,
    providerType: context.providerType,
  }), 'utf8');
}

function serializedSecret(value: Readonly<Record<string, string>>): Buffer {
  const entries = Object.entries(value);
  if (entries.length < 1 || entries.length > 16) {
    throw new ProviderSecretStoreError(400, 'provider-secret-input-invalid');
  }
  for (const [key, item] of entries) {
    if (!SECRET_KEY_PATTERN.test(key) || item.length < 1 || item.length > 4096) {
      throw new ProviderSecretStoreError(400, 'provider-secret-input-invalid');
    }
  }
  const serialized = JSON.stringify(Object.fromEntries(entries.sort(([left], [right]) =>
    left.localeCompare(right))));
  if (Buffer.byteLength(serialized, 'utf8') > 16 * 1024) {
    throw new ProviderSecretStoreError(413, 'provider-secret-input-too-large');
  }
  return Buffer.from(serialized, 'utf8');
}

function keyFor(
  keys: ReadonlyMap<number, Uint8Array>,
  version: number,
): Buffer {
  const key = keys.get(version);
  if (key === undefined || key.byteLength !== 32) {
    throw new ProviderSecretStoreError(503, 'provider-secret-key-unavailable');
  }
  return Buffer.from(key);
}

function parsedSecret(plaintext: Buffer): Readonly<Record<string, string>> {
  try {
    const value: unknown = JSON.parse(plaintext.toString('utf8'));
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('invalid');
    }
    const result: Record<string, string> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (!SECRET_KEY_PATTERN.test(key) || typeof item !== 'string') throw new Error('invalid');
      result[key] = item;
    }
    return Object.freeze(result);
  } catch {
    throw new ProviderSecretStoreError(503, 'provider-secret-decryption-failed');
  } finally {
    plaintext.fill(0);
  }
}

export class AesGcmProviderSecretStore implements ProviderSecretStore {
  readonly configured: boolean;
  readonly #repository: ProviderSecretEnvelopeRepository;
  readonly #keys: ReadonlyMap<number, Uint8Array>;
  readonly #activeKeyVersion: number;

  constructor(options: Readonly<AesGcmProviderSecretStoreOptions>) {
    this.#repository = options.repository;
    this.#keys = options.keys;
    this.#activeKeyVersion = options.activeKeyVersion;
    this.configured = options.repository.configured && options.keys.has(options.activeKeyVersion);
  }

  async store(
    context: Readonly<ProviderSecretContext>,
    value: Readonly<Record<string, string>>,
    now = new Date(),
  ): Promise<string> {
    if (!this.configured) {
      throw new ProviderSecretStoreError(503, 'provider-secret-store-not-configured');
    }
    const key = keyFor(this.#keys, this.#activeKeyVersion);
    const nonce = randomBytes(12);
    const plaintext = serializedSecret(value);
    try {
      const cipher = createCipheriv('aes-256-gcm', key, nonce);
      cipher.setAAD(associatedData(context));
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const envelope: StoredProviderSecretEnvelope = Object.freeze({
        id: randomUUID(),
        keyVersion: this.#activeKeyVersion,
        algorithm: 'aes-256-gcm',
        nonce,
        ciphertext,
        authenticationTag: cipher.getAuthTag(),
        createdAt: now.toISOString(),
      });
      await this.#repository.insert(context, envelope);
      return envelope.id;
    } finally {
      plaintext.fill(0);
      key.fill(0);
    }
  }

  async resolve(
    context: Readonly<ProviderSecretContext>,
    secretId: string,
  ): Promise<Readonly<Record<string, string>>> {
    const envelope = await this.#repository.read(context, secretId);
    if (envelope.revokedAt !== undefined) {
      throw new ProviderSecretStoreError(409, 'provider-secret-revoked');
    }
    const key = keyFor(this.#keys, envelope.keyVersion);
    try {
      const decipher = createDecipheriv(
        envelope.algorithm,
        key,
        Buffer.from(envelope.nonce),
      );
      decipher.setAAD(associatedData(context));
      decipher.setAuthTag(Buffer.from(envelope.authenticationTag));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext)),
        decipher.final(),
      ]);
      return parsedSecret(plaintext);
    } catch (error) {
      if (error instanceof ProviderSecretStoreError) throw error;
      throw new ProviderSecretStoreError(503, 'provider-secret-decryption-failed');
    } finally {
      key.fill(0);
    }
  }

  async replace(
    context: Readonly<ProviderSecretContext>,
    previousSecretId: string,
    value: Readonly<Record<string, string>>,
    now = new Date(),
  ): Promise<string> {
    const nextSecretId = await this.store(context, value, now);
    await this.#repository.revoke(context, previousSecretId, nextSecretId, now);
    return nextSecretId;
  }

  async revoke(
    context: Readonly<ProviderSecretContext>,
    secretId: string,
    now = new Date(),
  ): Promise<void> {
    await this.#repository.revoke(context, secretId, undefined, now);
  }
}

interface InMemoryEnvelopeEntry {
  readonly context: ProviderSecretContext;
  envelope: StoredProviderSecretEnvelope;
}

export class InMemoryProviderSecretEnvelopeRepository
implements ProviderSecretEnvelopeRepository {
  readonly configured = true;
  readonly #entries = new Map<string, InMemoryEnvelopeEntry>();

  async insert(
    context: Readonly<ProviderSecretContext>,
    envelope: Readonly<StoredProviderSecretEnvelope>,
  ): Promise<void> {
    this.#entries.set(envelope.id, {
      context: { ...context },
      envelope: Object.freeze({
        ...envelope,
        nonce: Uint8Array.from(envelope.nonce),
        ciphertext: Uint8Array.from(envelope.ciphertext),
        authenticationTag: Uint8Array.from(envelope.authenticationTag),
      }),
    });
  }

  async read(
    context: Readonly<ProviderSecretContext>,
    secretId: string,
  ): Promise<Readonly<StoredProviderSecretEnvelope>> {
    const entry = this.#entries.get(secretId);
    if (
      entry === undefined ||
      entry.context.clientId !== context.clientId ||
      entry.context.environment !== context.environment ||
      entry.context.serviceId !== context.serviceId ||
      entry.context.providerType !== context.providerType
    ) {
      throw new ProviderSecretStoreError(404, 'provider-secret-not-found');
    }
    return entry.envelope;
  }

  async revoke(
    context: Readonly<ProviderSecretContext>,
    secretId: string,
    _replacedBySecretId: string | undefined,
    now: Date,
  ): Promise<void> {
    const envelope = await this.read(context, secretId);
    const entry = this.#entries.get(secretId);
    if (entry !== undefined) {
      entry.envelope = Object.freeze({ ...envelope, revokedAt: now.toISOString() });
    }
  }
}

export function providerSecretKeyFromEnvironment(
  value: string | undefined,
): Uint8Array | undefined {
  const normalized = value?.trim();
  if (normalized === undefined || normalized === '') return undefined;
  try {
    const buffer = /^[a-fA-F0-9]{64}$/.test(normalized)
      ? Buffer.from(normalized, 'hex')
      : Buffer.from(normalized, 'base64');
    return buffer.byteLength === 32 ? Uint8Array.from(buffer) : undefined;
  } catch {
    return undefined;
  }
}
