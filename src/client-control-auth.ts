import { createHash } from 'node:crypto';
import type { PostgresQueryable } from './runtime-storage-registry-types.js';

export type ClientCredentialAuthenticationResult =
  | { readonly kind: 'authenticated'; readonly clientId: string; readonly displayLabel: string }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'disabled' }
  | { readonly kind: 'not-configured' };

export interface ClientCredentialAuthenticator {
  readonly configured: boolean;
  authenticate(input: Readonly<{
    clientId: string;
    clientCredential: string;
    now: Date;
  }>): Promise<Readonly<ClientCredentialAuthenticationResult>>;
}

interface ClientCredentialRow extends Record<string, unknown> {
  client_id: string;
  display_label: string;
  client_status: string;
  token_status: string;
  expires_at: Date | string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUndefinedTable(error: unknown): boolean {
  return isRecord(error) && error.code === '42P01';
}

function expirationTime(value: Date | string | null): number | null {
  if (value === null) return null;
  const result = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(result) ? result : Number.NaN;
}

export function createUnavailableClientCredentialAuthenticator(): ClientCredentialAuthenticator {
  return Object.freeze({
    configured: false,
    async authenticate(): Promise<Readonly<ClientCredentialAuthenticationResult>> {
      return Object.freeze({ kind: 'not-configured' });
    },
  });
}

export class PostgresStorageControlClientCredentialAuthenticator
implements ClientCredentialAuthenticator {
  readonly configured = true;
  readonly #queryable: PostgresQueryable;

  constructor(queryable: PostgresQueryable) {
    this.#queryable = queryable;
  }

  async authenticate(input: Readonly<{
    clientId: string;
    clientCredential: string;
    now: Date;
  }>): Promise<Readonly<ClientCredentialAuthenticationResult>> {
    const tokenDigest = createHash('sha256').update(input.clientCredential, 'utf8').digest('hex');
    try {
      const result = await this.#queryable.query<ClientCredentialRow>(`
SELECT
  clients.client_id,
  clients.display_label,
  clients.status AS client_status,
  tokens.status AS token_status,
  tokens.expires_at
FROM public.storage_control_clients AS clients
JOIN public.storage_control_client_tokens AS tokens
  ON tokens.storage_control_client_id = clients.id
WHERE clients.client_id = $1
  AND tokens.token_digest = $2
  AND tokens.token_purpose = 'browser-login'
LIMIT 1
`, [input.clientId, tokenDigest]);
      const row = result.rows[0];
      if (row === undefined) return Object.freeze({ kind: 'invalid' });
      if (row.client_status === 'disabled') return Object.freeze({ kind: 'disabled' });
      const expiresAt = expirationTime(row.expires_at);
      if (
        row.client_status !== 'active' ||
        row.token_status !== 'active' ||
        (expiresAt !== null && (!Number.isFinite(expiresAt) || expiresAt <= input.now.getTime()))
      ) {
        return Object.freeze({ kind: 'invalid' });
      }
      return Object.freeze({
        kind: 'authenticated',
        clientId: row.client_id,
        displayLabel: row.display_label,
      });
    } catch (error) {
      if (isUndefinedTable(error)) return Object.freeze({ kind: 'not-configured' });
      throw error;
    }
  }
}
