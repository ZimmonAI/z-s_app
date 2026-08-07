import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  PostgresQueryResult,
  PostgresQueryable,
} from '../src/runtime-storage-registry-types.js';
import { PostgresStorageServiceRepository } from '../src/storage-service-postgres.js';

interface CapturedQuery {
  readonly text: string;
  readonly values: readonly unknown[];
}

test('storage service lifecycle status query types timestamp parameters explicitly', async () => {
  const captured: CapturedQuery[] = [];
  const now = new Date('2026-08-07T06:51:14.000Z');

  const queryable: PostgresQueryable = {
    async query<Row extends Record<string, unknown>>(
      text: string,
      values: readonly unknown[] = [],
    ): Promise<PostgresQueryResult<Row>> {
      captured.push({ text, values });

      if (text.includes('UPDATE public.storage_control_storage_services AS services')) {
        return {
          rows: [{
            id: '11111111-1111-4111-8111-111111111111',
            client_id: 'client-a',
            environment: 'dev',
            service_id: 'r2-main',
            display_name: 'R2 main',
            provider_type: 'cloudflare-r2',
            ownership: 'client-owned',
            managed_secret_reference_id: null,
            status: 'archived',
            safe_metadata: {},
            capability_manifest: {},
            last_test_status: 'failed',
            last_tested_at: now,
            last_diagnostic_code: 'r2-connection-test-failed',
            created_at: now,
            updated_at: now,
          } as unknown as Row],
          rowCount: 1,
        };
      }

      return { rows: [], rowCount: 1 };
    },
  };

  const repository = new PostgresStorageServiceRepository(queryable);
  const result = await repository.setStatus(
    'client-a',
    'dev',
    'r2-main',
    'archived',
    now,
  );

  assert.equal(result.status, 'archived');
  assert.equal(captured.length, 2);

  const lifecycle = captured[0];
  assert.ok(lifecycle);
  assert.match(
    lifecycle.text,
    /WHEN \$4 = 'disabled' THEN \$5::timestamptz/,
  );
  assert.match(
    lifecycle.text,
    /ELSE NULL::timestamptz/,
  );
  assert.match(
    lifecycle.text,
    /WHEN \$4 = 'archived' THEN \$5::timestamptz/,
  );
  assert.match(lifecycle.text, /updated_at = \$5::timestamptz/);
  assert.deepEqual(lifecycle.values, [
    'client-a',
    'dev',
    'r2-main',
    'archived',
    now,
  ]);

  const activity = captured[1];
  assert.ok(activity);
  assert.match(activity.text, /storage_control_storage_service_events/);
  assert.equal(activity.values[4], 'storage-service-archived');
});
