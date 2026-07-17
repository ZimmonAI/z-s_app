import type {
  ProviderCredentialResolver,
  ResolvedS3CredentialBinding,
} from './runtime-s3-provider.js';

export interface ProviderSecretEnvironmentBinding {
  endpointEnv: string;
  regionEnv?: string;
  forcePathStyle?: boolean;
  accessKeyIdEnv: string;
  secretAccessKeyEnv: string;
  sessionTokenEnv?: string;
}

export interface RuntimeEnvironmentConfiguration {
  databaseUrl?: string;
  databasePoolMaximum: number;
  databaseIdleTimeoutMs: number;
  databaseConnectionTimeoutMs: number;
  maximumObjectByteLength: number;
  videoMakerBearerToken?: string;
  zXBearerToken?: string;
  uploadCompletionSigningKey?: string;
  objectReadGrantSigningKey?: string;
  providerSecretBindings: Readonly<Record<string, Readonly<ProviderSecretEnvironmentBinding>>>;
  safeConfigurationCodes: readonly string[];
}

const SAFE_ENV_NAME = /^[A-Z][A-Z0-9_]{0,127}$/;
const SAFE_REFERENCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

function optionalValue(environment: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = environment[name]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

function boundedInteger(
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
  codes: string[],
): number {
  const value = optionalValue(environment, name);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    codes.push(`invalid-${name.toLowerCase().replaceAll('_', '-')}`);
    return fallback;
  }
  return parsed;
}

function parseSecretBindings(
  environment: NodeJS.ProcessEnv,
  codes: string[],
): Readonly<Record<string, Readonly<ProviderSecretEnvironmentBinding>>> {
  const raw = optionalValue(environment, 'Z_S_PROVIDER_SECRET_BINDINGS_JSON');
  if (raw === undefined) {
    codes.push('provider-secret-bindings-missing');
    return Object.freeze({});
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    codes.push('provider-secret-bindings-invalid');
    return Object.freeze({});
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    codes.push('provider-secret-bindings-invalid');
    return Object.freeze({});
  }

  const bindings: Record<string, Readonly<ProviderSecretEnvironmentBinding>> = {};
  for (const [referenceId, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!SAFE_REFERENCE_ID.test(referenceId) || value === null || typeof value !== 'object' || Array.isArray(value)) {
      codes.push('provider-secret-bindings-invalid');
      return Object.freeze({});
    }
    const record = value as Record<string, unknown>;
    const endpointEnv = record.endpointEnv;
    const accessKeyIdEnv = record.accessKeyIdEnv;
    const secretAccessKeyEnv = record.secretAccessKeyEnv;
    const regionEnv = record.regionEnv;
    const sessionTokenEnv = record.sessionTokenEnv;
    const forcePathStyle = record.forcePathStyle;
    if (
      typeof endpointEnv !== 'string' ||
      !SAFE_ENV_NAME.test(endpointEnv) ||
      typeof accessKeyIdEnv !== 'string' ||
      !SAFE_ENV_NAME.test(accessKeyIdEnv) ||
      typeof secretAccessKeyEnv !== 'string' ||
      !SAFE_ENV_NAME.test(secretAccessKeyEnv) ||
      (regionEnv !== undefined && (typeof regionEnv !== 'string' || !SAFE_ENV_NAME.test(regionEnv))) ||
      (sessionTokenEnv !== undefined &&
        (typeof sessionTokenEnv !== 'string' || !SAFE_ENV_NAME.test(sessionTokenEnv))) ||
      (forcePathStyle !== undefined && typeof forcePathStyle !== 'boolean')
    ) {
      codes.push('provider-secret-bindings-invalid');
      return Object.freeze({});
    }
    const binding: ProviderSecretEnvironmentBinding = {
      endpointEnv,
      accessKeyIdEnv,
      secretAccessKeyEnv,
    };
    if (typeof regionEnv === 'string') binding.regionEnv = regionEnv;
    if (typeof sessionTokenEnv === 'string') binding.sessionTokenEnv = sessionTokenEnv;
    if (typeof forcePathStyle === 'boolean') binding.forcePathStyle = forcePathStyle;
    bindings[referenceId] = Object.freeze(binding);
  }
  if (Object.keys(bindings).length === 0) codes.push('provider-secret-bindings-missing');
  return Object.freeze(bindings);
}

export function readRuntimeEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): Readonly<RuntimeEnvironmentConfiguration> {
  const codes: string[] = [];
  const databaseUrl = optionalValue(environment, 'Z_S_DATABASE_URL');
  if (databaseUrl === undefined) codes.push('database-url-missing');
  const uploadCompletionSigningKey = optionalValue(environment, 'Z_S_UPLOAD_COMPLETION_SIGNING_KEY');
  if (uploadCompletionSigningKey === undefined || uploadCompletionSigningKey.length < 32) {
    codes.push('upload-signing-key-missing');
  }
  const objectReadGrantSigningKey = optionalValue(environment, 'Z_S_OBJECT_READ_GRANT_SIGNING_KEY');
  if (objectReadGrantSigningKey === undefined || objectReadGrantSigningKey.length < 32) {
    codes.push('read-signing-key-missing');
  }

  const configuration: RuntimeEnvironmentConfiguration = {
    databasePoolMaximum: boundedInteger(environment, 'Z_S_RUNTIME_DB_POOL_MAX', 8, 1, 32, codes),
    databaseIdleTimeoutMs: boundedInteger(
      environment,
      'Z_S_RUNTIME_DB_IDLE_TIMEOUT_MS',
      30_000,
      1_000,
      300_000,
      codes,
    ),
    databaseConnectionTimeoutMs: boundedInteger(
      environment,
      'Z_S_RUNTIME_DB_CONNECTION_TIMEOUT_MS',
      5_000,
      500,
      60_000,
      codes,
    ),
    maximumObjectByteLength: boundedInteger(
      environment,
      'Z_S_RUNTIME_MAX_OBJECT_BYTES',
      32 * 1024 * 1024,
      1,
      512 * 1024 * 1024,
      codes,
    ),
    providerSecretBindings: parseSecretBindings(environment, codes),
    safeConfigurationCodes: Object.freeze([...new Set(codes)]),
  };
  if (databaseUrl !== undefined) configuration.databaseUrl = databaseUrl;
  const videoMakerBearerToken = optionalValue(environment, 'Z_S_VIDEO_MAKER_BEARER_TOKEN');
  if (videoMakerBearerToken !== undefined) configuration.videoMakerBearerToken = videoMakerBearerToken;
  const zXBearerToken = optionalValue(environment, 'Z_S_Z_X_BEARER_TOKEN');
  if (zXBearerToken !== undefined) configuration.zXBearerToken = zXBearerToken;
  if (uploadCompletionSigningKey !== undefined && uploadCompletionSigningKey.length >= 32) {
    configuration.uploadCompletionSigningKey = uploadCompletionSigningKey;
  }
  if (objectReadGrantSigningKey !== undefined && objectReadGrantSigningKey.length >= 32) {
    configuration.objectReadGrantSigningKey = objectReadGrantSigningKey;
  }
  return Object.freeze(configuration);
}

export class EnvironmentProviderCredentialResolver implements ProviderCredentialResolver {
  readonly #environment: NodeJS.ProcessEnv;
  readonly #bindings: Readonly<Record<string, Readonly<ProviderSecretEnvironmentBinding>>>;

  constructor(input: {
    environment?: NodeJS.ProcessEnv;
    bindings: Readonly<Record<string, Readonly<ProviderSecretEnvironmentBinding>>>;
  }) {
    this.#environment = input.environment ?? process.env;
    this.#bindings = input.bindings;
  }

  readinessCode(referenceId: string): string | undefined {
    const binding = this.#bindings[referenceId];
    if (binding === undefined) return 'provider-secret-reference-unmapped';
    const endpoint = optionalValue(this.#environment, binding.endpointEnv);
    const accessKeyId = optionalValue(this.#environment, binding.accessKeyIdEnv);
    const secretAccessKey = optionalValue(this.#environment, binding.secretAccessKeyEnv);
    if (endpoint === undefined || accessKeyId === undefined || secretAccessKey === undefined) {
      return 'provider-credential-environment-missing';
    }
    try {
      const url = new URL(endpoint);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        return 'provider-endpoint-invalid';
      }
    } catch {
      return 'provider-endpoint-invalid';
    }
    if (binding.regionEnv !== undefined && optionalValue(this.#environment, binding.regionEnv) === undefined) {
      return 'provider-region-environment-missing';
    }
    if (
      binding.sessionTokenEnv !== undefined &&
      optionalValue(this.#environment, binding.sessionTokenEnv) === undefined
    ) {
      return 'provider-session-token-environment-missing';
    }
    return undefined;
  }

  async resolve(secretReferenceId: string): Promise<Readonly<ResolvedS3CredentialBinding>> {
    const code = this.readinessCode(secretReferenceId);
    if (code !== undefined) throw new Error(code);
    const binding = this.#bindings[secretReferenceId];
    if (binding === undefined) throw new Error('provider-secret-reference-unmapped');
    const result: ResolvedS3CredentialBinding = {
      endpoint: optionalValue(this.#environment, binding.endpointEnv) as string,
      region:
        binding.regionEnv === undefined
          ? 'auto'
          : (optionalValue(this.#environment, binding.regionEnv) as string),
      forcePathStyle: binding.forcePathStyle ?? false,
      accessKeyId: optionalValue(this.#environment, binding.accessKeyIdEnv) as string,
      secretAccessKey: optionalValue(this.#environment, binding.secretAccessKeyEnv) as string,
    };
    if (binding.sessionTokenEnv !== undefined) {
      result.sessionToken = optionalValue(this.#environment, binding.sessionTokenEnv) as string;
    }
    return Object.freeze(result);
  }
}
