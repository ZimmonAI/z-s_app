import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PostgresStorageControlClientCredentialAuthenticator,
  type ClientCredentialAuthenticationResult,
} from '../src/client-control-auth.js';
import type {
  PostgresQueryable,
  PostgresQueryResult,
} from '../src/runtime-storage-registry-types.js';

interface AuthenticationRow extends Record<string, unknown> {
  client_id: string;
  display_label: string;
  client_status: string;
  token_status: string;
  expires_at: Date | string | null;
}

class FakeQueryable implements PostgresQueryable {
  readonly rows: AuthenticationRow[];
  queryText = '';
  queryValues: readonly unknown[] = [];

  constructor(rows: AuthenticationRow[]) {
    this.rows = rows;
  }

  async query<Row extends Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<PostgresQueryResult<Row>> {
    this.queryText = text;
    this.queryValues = values;
    return { rows: this.rows as unknown as Row[], rowCount: this.rows.length };
  }
}

function serialized(result: Readonly<ClientCredentialAuthenticationResult>): string {
  return JSON.stringify(result);
}

test('authenticates active video-maker browser-login token by digest', async () => {
  const queryable = new FakeQueryable([{
    client_id: 'video-maker_app',
    display_label: 'Video Maker',
    client_status: 'active',
    token_status: 'active',
    expires_at: null,
  }]);
  const authenticator = new PostgresStorageControlClientCredentialAuthenticator(queryable);
  const rawCredential = 'fixture-client-credential';
  const result = await authenticator.authenticate({
    clientId: 'video-maker_app',
    clientCredential: rawCredential,
    now: new Date('2026-08-01T00:00:00.000Z'),
  });

  assert.deepEqual(result, {
    kind: 'authenticated',
    clientId: 'video-maker_app',
    displayLabel: 'Video Maker',
  });
  assert.equal(queryable.queryValues[0], 'video-maker_app');
  assert.equal(typeof queryable.queryValues[1], 'string');
  assert.notEqual(queryable.queryValues[1], rawCredential);
  assert.match(String(queryable.queryValues[1]), /^[a-f0-9]{64}$/);
  assert.match(queryable.queryText, /tokens\.token_purpose = 'browser-login'/);
  assert.doesNotMatch(serialized(result), new RegExp(rawCredential));
});

test('rejects disabled client and expired token without revealing token material', async () => {
  const now = new Date('2026-08-01T00:00:00.000Z');
  const rawCredential = 'another-fixture-credential';
  const disabled = new PostgresStorageControlClientCredentialAuthenticator(new FakeQueryable([{
    client_id: 'video-maker_app',
    display_label: 'Video Maker',
    client_status: 'disabled',
    token_status: 'active',
    expires_at: null,
  }]));
  const expired = new PostgresStorageControlClientCredentialAuthenticator(new FakeQueryable([{
    client_id: 'video-maker_app',
    display_label: 'Video Maker',
    client_status: 'active',
    token_status: 'active',
    expires_at: new Date('2026-07-31T23:59:59.000Z'),
  }]));

  const disabledResult = await disabled.authenticate({
    clientId: 'video-maker_app',
    clientCredential: rawCredential,
    now,
  });
  const expiredResult = await expired.authenticate({
    clientId: 'video-maker_app',
    clientCredential: rawCredential,
    now,
  });

  assert.deepEqual(disabledResult, { kind: 'disabled' });
  assert.deepEqual(expiredResult, { kind: 'invalid' });
  assert.doesNotMatch(
    `${serialized(disabledResult)}${serialized(expiredResult)}`,
    new RegExp(rawCredential),
  );
});
