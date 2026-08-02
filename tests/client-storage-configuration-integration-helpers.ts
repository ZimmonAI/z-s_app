import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Pool, type PoolClient } from 'pg';
import {
  ClientStorageConfigurationError,
  type ConfigurationDraftDocument,
} from '../src/client-storage-configuration.js';
import type {
  PostgresClientLike,
  PostgresPoolLike,
  PostgresQueryable,
  PostgresQueryResult,
} from '../src/runtime-storage-registry-types.js';

export const databaseUrl = process.env.TEST_DATABASE_URL;
export const integrationTest = databaseUrl === undefined ? test.skip : test;

function queryValues(values?: readonly unknown[]): unknown[] | undefined {
  return values === undefined ? undefined : [...values];
}

function adaptClient(client: PoolClient): PostgresClientLike {
  return {
    query: async <Row extends Record<string, unknown>>(
      text: string,
      values?: readonly unknown[],
    ): Promise<PostgresQueryResult<Row>> => {
      const result = await client.query<Row>(text, queryValues(values));
      return { rows: result.rows, rowCount: result.rowCount };
    },
    release: () => client.release(),
  };
}

export function adaptPool(pool: Pool): PostgresPoolLike & PostgresQueryable {
  return {
    connect: async () => adaptClient(await pool.connect()),
    query: async <Row extends Record<string, unknown>>(
      text: string,
      values?: readonly unknown[],
    ): Promise<PostgresQueryResult<Row>> => {
      const result = await pool.query<Row>(text, queryValues(values));
      return { rows: result.rows, rowCount: result.rowCount };
    },
  };
}

export async function resetAndApplyThrough0004(pool: Pool): Promise<void> {
  await pool.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
  for (const migration of [
    '0001_z_s_control_plane_foundation.sql',
    '0002_z_s_runtime_registry.sql',
    '0003_z_s_read_delivery.sql',
    '0004_z_s_storage_control_vaults.sql',
  ] as const) {
    await pool.query(await readFile(`db/migrations/${migration}`, 'utf8'));
  }
}

export async function apply0005(pool: Pool): Promise<void> {
  await pool.query(
    await readFile('db/migrations/0005_z_s_client_storage_configuration.sql', 'utf8'),
  );
}

export async function applyConfigurationCleanupMigrations(pool: Pool): Promise<void> {
  for (const migration of [
    '0006_z_s_configuration_audit_cleanup.sql',
    '0007_z_s_configuration_child_cleanup.sql',
    '0008_z_s_configuration_audit_nullification.sql',
    '0009_z_s_configuration_child_fk_deferral.sql',
  ] as const) {
    await pool.query(await readFile(`db/migrations/${migration}`, 'utf8'));
  }
}

export async function seedClients(pool: Pool): Promise<void> {
  const now = new Date('2026-08-02T00:00:00.000Z');
  const videoMakerId = randomUUID();
  const otherClientId = randomUUID();

  await pool.query(
    `
INSERT INTO public.storage_control_clients (
  id, client_id, display_label, status, created_at, updated_at
) VALUES
  ($1, 'video-maker_app', 'Video Maker', 'active', $3, $3),
  ($2, 'other-client', 'Other Client', 'active', $3, $3)
`,
    [videoMakerId, otherClientId, now],
  );

  await pool.query(
    `
INSERT INTO public.managed_apps (
  id, app_id, environment, status, created_at, updated_at
) VALUES
  ($1, 'video-maker_app', 'dev', 'active', $3, $3),
  ($2, 'other-client', 'dev', 'active', $3, $3)
`,
    [videoMakerId, otherClientId, now],
  );
}

export function configurationDraftDocument(): ConfigurationDraftDocument {
  return {
    providerConnections: [
      {
        connectionId: 'minio-primary',
        displayLabel: 'MinIO primary',
        providerType: 'minio',
        secretReferenceId: 'vault:z-s:minio-primary',
        safeMetadata: { regionLabel: 'local-primary' },
      },
      {
        connectionId: 'r2-hot',
        displayLabel: 'R2 hot',
        providerType: 'r2',
        secretReferenceId: 'vault:z-s:r2-hot',
        safeMetadata: { regionLabel: 'global-hot' },
      },
    ],
    vaults: [
      {
        vaultId: 'originals',
        providerConnectionId: 'minio-primary',
        displayLabel: 'Originals',
        purpose: 'originals',
        bucketLabel: 'video-maker-originals',
        prefixTemplate: 'video-maker/originals/*',
        retention: { mode: 'permanent' },
      },
      {
        vaultId: 'hot-copy',
        providerConnectionId: 'r2-hot',
        displayLabel: 'Hot copy',
        purpose: 'hot-copy',
        bucketLabel: 'video-maker-hot',
        prefixTemplate: 'video-maker/hot/*',
        retention: { mode: 'delete-after-days', deleteAfterDays: 7 },
      },
      {
        vaultId: 'derivatives',
        providerConnectionId: 'r2-hot',
        displayLabel: 'Derivatives',
        purpose: 'derivatives',
        bucketLabel: 'video-maker-derivatives',
        prefixTemplate: 'video-maker/derivatives/*',
        retention: { mode: 'permanent' },
      },
    ],
    imagePresets: [
      {
        presetId: 'web-images',
        targetVaultId: 'derivatives',
        widths: [512, 1024],
        outputFormat: 'webp',
        quality: 82,
        fit: 'inside',
      },
    ],
    routes: [
      {
        routeId: 'images',
        assetClass: 'image',
        targets: [
          { role: 'primary', vaultId: 'originals' },
          { role: 'replica', vaultId: 'hot-copy' },
        ],
        imagePresetId: 'web-images',
      },
      {
        routeId: 'videos',
        assetClass: 'video',
        targets: [{ role: 'primary', vaultId: 'originals' }],
      },
      {
        routeId: 'documents',
        assetClass: 'document',
        targets: [{ role: 'primary', vaultId: 'originals' }],
      },
    ],
  };
}

export function configurationError(code: string): (error: unknown) => boolean {
  return (error) => error instanceof ClientStorageConfigurationError && error.code === code;
}
