import { PostgresRuntimeStorageRegistryDuplicateCore } from './runtime-storage-registry-duplicate.js';
import {
  RuntimeStorageRegistryError,
  type ConfiguredObjectWriteIntentExecutionContext,
  type ConfiguredProviderCopyExecutionContext,
  type ConfiguredStorageObjectCopySnapshot,
  type CreateConfiguredObjectWriteIntentInput,
  type CreateObjectWriteIntentInput,
  type ObjectWriteIntentExecutionContext,
  type RuntimeObjectWriteIntentExecutionContext,
  type ObjectWriteIntentSnapshot,
  type ObjectWriteIntentState,
  type PostgresQueryable,
  type ProviderRole,
  type StorageObjectCopyRow,
  type StorageObjectCopyState,
  type StorageObjectCopySnapshot,
  type StorageObjectRow,
  type StorageObjectSnapshot,
  type WriteIntentExecutionRow,
  type WriteIntentRow,
} from './runtime-storage-registry-types.js';
import {
  COPY_TRANSITIONS,
  WRITE_INTENT_TRANSITIONS,
  asIso,
  asNumber,
  assertSafeJsonObject,
  optionalIso,
  requireSha256,
  requireUuid,
} from './runtime-storage-registry-support.js';

interface ConfiguredAuthorityRow extends Record<string, unknown> {
  configuration_route_target_id: string;
  configuration_vault_id: string;
  provider_connection_id: string;
  target_role: 'primary' | 'replica';
  target_order: number;
  provider_type: 'minio' | 'r2' | 's3-compatible';
  bucket_label: string;
  prefix_template: string;
  secret_reference_id: string;
}

interface ConfiguredExecutionBaseRow extends WriteIntentRow {
  storage_control_client_id: string;
  caller_app_id: string;
  caller_service_id: string | null;
  configuration_version_id: string;
  configuration_fingerprint: string;
  configuration_route_id: string;
  app_correlation_ref: string;
  source_reference: string;
  expected_content_type: string;
  expected_byte_length: string | number;
  expected_checksum_sha256: string;
  registry_state: 'reserved' | 'active' | 'degraded' | 'delete_pending' | 'deleted';
  object_protection_stage: string;
  object_row_version: number;
}

interface ConfiguredExecutionCopyRow extends ConfiguredAuthorityRow {
  storage_object_copy_id: string;
  copy_state: StorageObjectCopyState;
  copy_row_version: number;
  internal_locator: string;
}

interface RuntimeCopyRow extends Record<string, unknown> {
  storage_object_copy_id: string;
  storage_object_id: string;
  provider_role: ProviderRole | null;
  configuration_route_target_id: string | null;
  target_role: 'primary' | 'replica' | null;
  target_order: number | null;
  copy_state: StorageObjectCopyState;
  observed_checksum_sha256: string | null;
  observed_byte_length: string | number | null;
  latest_verified_at: Date | string | null;
  row_version: number;
  updated_at: Date | string;
}

export class PostgresRuntimeStorageRegistryObjectCore extends PostgresRuntimeStorageRegistryDuplicateCore {
  async createObjectWriteIntent(
    input: CreateObjectWriteIntentInput,
  ): Promise<Readonly<{ intent: ObjectWriteIntentSnapshot; object: StorageObjectSnapshot }>> {
    if (!Number.isSafeInteger(input.expectedByteLength) || input.expectedByteLength <= 0) {
      throw new RuntimeStorageRegistryError('invalid-request', 'invalid-expected-byte-length', 400);
    }
    requireSha256(input.expectedChecksumSha256, 'expected-checksum-sha256');
    const metadata = input.safeTechnicalMetadata ?? {};
    assertSafeJsonObject(metadata, 'safe-technical-metadata');

    return this.scope.run(async (client) => {
      const authorityRows = await client.query<{ normalized_prefix_pattern: string }>(
        `SELECT prefix_class.normalized_prefix_pattern
           FROM public.storage_profiles AS profile
           JOIN public.storage_prefix_classes AS prefix_class
             ON prefix_class.storage_profile_id = profile.id
          WHERE profile.id = $1
            AND profile.managed_app_id = $2
            AND prefix_class.id = $3
            AND prefix_class.status = 'active'`,
        [input.storageProfileId, input.managedAppId, input.storagePrefixClassId],
      );
      const authority = authorityRows.rows[0];
      if (authority === undefined) {
        throw new RuntimeStorageRegistryError('invalid-request', 'invalid-profile-prefix-authority', 400);
      }
      const locatorPrefix = authority.normalized_prefix_pattern.endsWith('*')
        ? authority.normalized_prefix_pattern.slice(0, -1)
        : authority.normalized_prefix_pattern;
      for (const locator of Object.values(input.internalLocators)) {
        if (
          !locator.startsWith(locatorPrefix) ||
          locator.startsWith('/') ||
          locator.includes('..') ||
          locator.includes('\\') ||
          locator.includes('://')
        ) {
          throw new RuntimeStorageRegistryError('invalid-request', 'invalid-internal-locator', 400);
        }
      }

      const bindingRows = await client.query<{ id: string; provider_role: ProviderRole }>(
        `SELECT id, provider_role
           FROM public.storage_profile_provider_bindings
          WHERE storage_profile_id = $1 AND id = ANY($2::uuid[])
          ORDER BY provider_role`,
        [input.storageProfileId, [input.hotProviderBindingId, input.canonicalProviderBindingId]],
      );
      const bindingByRole = new Map(bindingRows.rows.map((row) => [row.provider_role, row.id]));
      if (
        bindingByRole.get('hot') !== input.hotProviderBindingId ||
        bindingByRole.get('canonical') !== input.canonicalProviderBindingId
      ) {
        throw new RuntimeStorageRegistryError('invalid-request', 'invalid-provider-binding-set', 400);
      }

      const now = this.now();
      const storageObjectId = this.createId();
      const objectWriteIntentId = this.createId();
      const initialStage = input.requestedObjectProtectionStage ?? 'write-intent-created';

      await client.query(
        `INSERT INTO public.storage_objects (
           storage_object_id, managed_app_id, storage_profile_id, storage_profile_fingerprint,
           storage_prefix_class_id, app_correlation_ref, source_reference, registry_state,
           object_protection_stage, expected_checksum_sha256, expected_byte_length,
           expected_content_type, safe_technical_metadata, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'reserved', $8, $9, $10, $11, $12::jsonb, $13, $13)`,
        [
          storageObjectId,
          input.managedAppId,
          input.storageProfileId,
          input.storageProfileFingerprint,
          input.storagePrefixClassId,
          input.appCorrelationReference,
          input.sourceReference,
          initialStage,
          input.expectedChecksumSha256,
          input.expectedByteLength,
          input.expectedContentType,
          JSON.stringify(metadata),
          now,
        ],
      );

      await client.query(
        `INSERT INTO public.object_write_intents (
           object_write_intent_id, managed_app_id, caller_service_id, storage_profile_id,
           storage_profile_fingerprint, storage_prefix_class_id, app_correlation_ref,
           source_reference, expected_content_type, expected_byte_length,
           expected_checksum_sha256, requested_object_protection_stage, storage_object_id,
           state, expires_at, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
                   'accepted', $14, $15, $15)`,
        [
          objectWriteIntentId,
          input.managedAppId,
          input.callerServiceId ?? null,
          input.storageProfileId,
          input.storageProfileFingerprint,
          input.storagePrefixClassId,
          input.appCorrelationReference,
          input.sourceReference,
          input.expectedContentType,
          input.expectedByteLength,
          input.expectedChecksumSha256,
          input.requestedObjectProtectionStage ?? null,
          storageObjectId,
          input.expiresAt,
          now,
        ],
      );

      for (const providerRole of ['hot', 'canonical'] as const) {
        await client.query(
          `INSERT INTO public.storage_object_copies (
             storage_object_copy_id, storage_object_id,
             storage_profile_provider_binding_id, provider_role, internal_locator,
             copy_state, created_at, updated_at
           ) VALUES ($1, $2, $3, $4, $5, 'pending', $6, $6)`,
          [
            this.createId(),
            storageObjectId,
            providerRole === 'hot'
              ? input.hotProviderBindingId
              : input.canonicalProviderBindingId,
            providerRole,
            input.internalLocators[providerRole],
            now,
          ],
        );
      }

      return Object.freeze({
        intent: await this.readIntent(client, objectWriteIntentId),
        object: await this.readObject(client, storageObjectId),
      });
    });
  }

  async createConfiguredObjectWriteIntent(
    input: CreateConfiguredObjectWriteIntentInput,
  ): Promise<Readonly<{ intent: ObjectWriteIntentSnapshot; object: StorageObjectSnapshot }>> {
    requireUuid(input.storageObjectId, 'configured-storage-object');
    requireUuid(input.storageControlClientId, 'configured-storage-control-client');
    requireUuid(input.configurationVersionId, 'configured-configuration-version');
    requireUuid(input.configurationRouteId, 'configured-configuration-route');
    requireSha256(input.configurationFingerprint, 'configuration-fingerprint');
    if (!Number.isSafeInteger(input.expectedByteLength) || input.expectedByteLength <= 0) {
      throw new RuntimeStorageRegistryError('invalid-request', 'invalid-expected-byte-length', 400);
    }
    requireSha256(input.expectedChecksumSha256, 'expected-checksum-sha256');
    const metadata = input.safeTechnicalMetadata ?? {};
    assertSafeJsonObject(metadata, 'safe-technical-metadata');
    const targets = [...input.targets].sort((left, right) =>
      left.role === right.role
        ? left.order - right.order
        : left.role === 'primary'
          ? -1
          : 1,
    );
    const primary = targets.filter((target) => target.role === 'primary');
    const replicaOrders = new Set<number>();
    if (primary.length !== 1 || primary[0]?.order !== 0 || targets.length === 0) {
      throw new RuntimeStorageRegistryError('invalid-request', 'configuration-primary-target-not-ready', 503, true);
    }
    for (const target of targets) {
      requireUuid(target.configurationRouteTargetId, 'configuration-route-target');
      requireUuid(target.configurationVaultId, 'configuration-vault');
      requireUuid(target.providerConnectionId, 'provider-connection');
      if (target.role === 'replica') {
        if (!Number.isSafeInteger(target.order) || target.order <= 0 || replicaOrders.has(target.order)) {
          throw new RuntimeStorageRegistryError('invalid-request', 'configuration-route-target-order-invalid', 409);
        }
        replicaOrders.add(target.order);
      }
      if (target.internalLocator.startsWith('/') || target.internalLocator.includes('..') ||
          target.internalLocator.includes('\\') || target.internalLocator.includes('://')) {
        throw new RuntimeStorageRegistryError('invalid-request', 'invalid-internal-locator', 400);
      }
    }

    return this.scope.run(async (client) => {
      const authority = await client.query<ConfiguredAuthorityRow>(
        `SELECT target.id AS configuration_route_target_id,
                vault.id AS configuration_vault_id,
                connection.id AS provider_connection_id,
                target.target_role, target.target_order, connection.provider_type,
                vault.bucket_label, vault.prefix_template, connection.secret_reference_id
           FROM public.storage_control_configuration_route_targets AS target
           JOIN public.storage_control_configuration_vaults AS vault
             ON vault.storage_control_client_id = target.storage_control_client_id
            AND vault.configuration_version_id = target.configuration_version_id
            AND vault.id = target.vault_id
           JOIN public.storage_control_provider_connections AS connection
             ON connection.storage_control_client_id = target.storage_control_client_id
            AND connection.id = vault.provider_connection_id
          WHERE target.storage_control_client_id = $1
            AND target.configuration_version_id = $2
            AND target.configuration_route_id = $3
            AND target.id = ANY($4::uuid[])
          ORDER BY CASE target.target_role WHEN 'primary' THEN 0 ELSE 1 END,
                   target.target_order, target.id`,
        [
          input.storageControlClientId,
          input.configurationVersionId,
          input.configurationRouteId,
          targets.map((target) => target.configurationRouteTargetId),
        ],
      );
      const persisted = new Map(authority.rows.map((row) => [row.configuration_route_target_id, row]));
      if (persisted.size !== targets.length) {
        throw new RuntimeStorageRegistryError('invalid-request', 'configuration-provider-connection-not-ready', 503, true);
      }
      for (const target of targets) {
        const row = persisted.get(target.configurationRouteTargetId);
        if (row === undefined ||
            row.configuration_vault_id !== target.configurationVaultId ||
            row.provider_connection_id !== target.providerConnectionId ||
            row.target_role !== target.role || row.target_order !== target.order ||
            row.provider_type !== target.providerType || row.bucket_label !== target.bucketLabel ||
            row.prefix_template !== target.prefixTemplate ||
            row.secret_reference_id !== target.secretReferenceId) {
          throw new RuntimeStorageRegistryError('invalid-request', 'configuration-route-target-authority-mismatch', 409);
        }
      }

      const now = this.now();
      const objectWriteIntentId = this.createId();
      const initialStage = input.requestedObjectProtectionStage ?? 'write-intent-created';
      await client.query(
        `INSERT INTO public.storage_objects (
           storage_object_id, managed_app_id, storage_profile_id, storage_profile_fingerprint,
           storage_prefix_class_id, storage_control_client_id, configuration_version_id,
           configuration_fingerprint, configuration_route_id, app_correlation_ref,
           source_reference, registry_state, object_protection_stage, expected_checksum_sha256,
           expected_byte_length, expected_content_type, safe_technical_metadata, created_at, updated_at
         ) VALUES ($1, NULL, NULL, NULL, NULL, $2, $3, $4, $5, $6, $7, 'reserved', $8,
                   $9, $10, $11, $12::jsonb, $13, $13)`,
        [input.storageObjectId, input.storageControlClientId, input.configurationVersionId,
         input.configurationFingerprint, input.configurationRouteId, input.appCorrelationReference,
         input.sourceReference, initialStage, input.expectedChecksumSha256, input.expectedByteLength,
         input.expectedContentType, JSON.stringify(metadata), now],
      );
      await client.query(
        `INSERT INTO public.object_write_intents (
           object_write_intent_id, managed_app_id, caller_service_id, storage_profile_id,
           storage_profile_fingerprint, storage_prefix_class_id, storage_control_client_id,
           configuration_version_id, configuration_fingerprint, configuration_route_id,
           app_correlation_ref, source_reference, expected_content_type, expected_byte_length,
           expected_checksum_sha256, requested_object_protection_stage, storage_object_id,
           state, expires_at, created_at, updated_at
         ) VALUES ($1, NULL, $2, NULL, NULL, NULL, $3, $4, $5, $6, $7, $8, $9, $10,
                   $11, $12, $13, 'accepted', $14, $15, $15)`,
        [objectWriteIntentId, input.callerServiceId ?? null, input.storageControlClientId,
         input.configurationVersionId, input.configurationFingerprint, input.configurationRouteId,
         input.appCorrelationReference, input.sourceReference, input.expectedContentType,
         input.expectedByteLength, input.expectedChecksumSha256,
         input.requestedObjectProtectionStage ?? null, input.storageObjectId, input.expiresAt, now],
      );
      for (const target of targets) {
        await client.query(
          `INSERT INTO public.storage_object_copies (
             storage_object_copy_id, storage_object_id, storage_profile_provider_binding_id,
             provider_role, configuration_route_target_id, configuration_vault_id,
             provider_connection_id, target_role, target_order, internal_locator,
             copy_state, created_at, updated_at
           ) VALUES ($1, $2, NULL, NULL, $3, $4, $5, $6, $7, $8, 'pending', $9, $9)`,
          [this.createId(), input.storageObjectId, target.configurationRouteTargetId,
           target.configurationVaultId, target.providerConnectionId, target.role, target.order,
           target.internalLocator, now],
        );
      }
      return Object.freeze({
        intent: await this.readIntent(client, objectWriteIntentId),
        object: await this.readObject(client, input.storageObjectId),
      });
    });
  }

  async getObjectWriteIntent(objectWriteIntentId: string): Promise<ObjectWriteIntentSnapshot | null> {
    return this.scope.run(async (client) => {
      const result = await client.query<WriteIntentRow>(
        `SELECT object_write_intent_id, storage_object_id, state, expires_at, terminal_at,
                row_version, created_at, updated_at
           FROM public.object_write_intents
          WHERE object_write_intent_id = $1`,
        [objectWriteIntentId],
      );
      const row = result.rows[0];
      return row === undefined ? null : this.mapIntent(row);
    });
  }

  async getObjectWriteIntentExecutionContext(
    objectWriteIntentId: string,
  ): Promise<RuntimeObjectWriteIntentExecutionContext | null> {
    return this.scope.run((client) => this.readExecutionContext(client, objectWriteIntentId, false));
  }

  async expireObjectWriteIntentIfDue(objectWriteIntentId: string): Promise<boolean> {
    return this.scope.run(async (client) => {
      const now = this.now();
      const result = await client.query(
        `UPDATE public.object_write_intents
            SET state = 'expired', terminal_at = $2, updated_at = $2,
                row_version = row_version + 1
          WHERE object_write_intent_id = $1
            AND state IN ('accepted', 'uploading')
            AND expires_at <= $2`,
        [objectWriteIntentId, now],
      );
      return result.rowCount === 1;
    });
  }

  async beginObjectUpload(input: {
    objectWriteIntentId: string;
    expectedRowVersion: number;
  }): Promise<RuntimeObjectWriteIntentExecutionContext> {
    return this.scope.run(async (client) => {
      const now = this.now();
      const result = await client.query<WriteIntentRow>(
        `UPDATE public.object_write_intents
            SET state = 'uploading', updated_at = $3, row_version = row_version + 1
          WHERE object_write_intent_id = $1
            AND state = 'accepted'
            AND row_version = $2
            AND expires_at > $3
          RETURNING object_write_intent_id, storage_object_id, state, expires_at, terminal_at,
                    row_version, created_at, updated_at`,
        [input.objectWriteIntentId, input.expectedRowVersion, now],
      );
      if (result.rows[0] === undefined) {
        throw new RuntimeStorageRegistryError(
          'duplicate-conflict',
          'object-write-intent-begin-conflict',
          409,
        );
      }
      const context = await this.readExecutionContext(client, input.objectWriteIntentId, true);
      if (context === null) {
        throw new RuntimeStorageRegistryError('internal', 'write-intent-missing', 500);
      }
      return context;
    });
  }

  async completeObjectUpload(input: {
    objectWriteIntentId: string;
    expectedRowVersion: number;
    checksumSha256: string;
    byteLength: number;
  }): Promise<RuntimeObjectWriteIntentExecutionContext> {
    requireSha256(input.checksumSha256, 'upload-checksum-sha256');
    if (!Number.isSafeInteger(input.byteLength) || input.byteLength <= 0) {
      throw new RuntimeStorageRegistryError('invalid-request', 'invalid-upload-byte-length', 400);
    }
    return this.scope.run(async (client) => {
      const now = this.now();
      const intentResult = await client.query<{ storage_object_id: string }>(
        `UPDATE public.object_write_intents
            SET state = 'completed', terminal_at = $3, updated_at = $3,
                row_version = row_version + 1
          WHERE object_write_intent_id = $1
            AND state = 'uploading'
            AND row_version = $2
          RETURNING storage_object_id`,
        [input.objectWriteIntentId, input.expectedRowVersion, now],
      );
      const intent = intentResult.rows[0];
      if (intent === undefined) {
        throw new RuntimeStorageRegistryError(
          'duplicate-conflict',
          'object-write-intent-complete-conflict',
          409,
        );
      }
      const objectResult = await client.query(
        `UPDATE public.storage_objects
            SET object_protection_stage = 'upload-completion-recorded',
                updated_at = $4, row_version = row_version + 1
          WHERE storage_object_id = $1
            AND registry_state = 'reserved'
            AND expected_checksum_sha256 = $2
            AND expected_byte_length = $3`,
        [intent.storage_object_id, input.checksumSha256, input.byteLength, now],
      );
      if (objectResult.rowCount !== 1) {
        throw new RuntimeStorageRegistryError('duplicate-conflict', 'storage-object-complete-conflict', 409);
      }
      const context = await this.readExecutionContext(client, input.objectWriteIntentId, true);
      if (context === null) {
        throw new RuntimeStorageRegistryError('internal', 'write-intent-missing', 500);
      }
      return context;
    });
  }

  async cancelObjectWriteIntent(input: {
    objectWriteIntentId: string;
    expectedState: 'accepted' | 'uploading';
    expectedRowVersion: number;
  }): Promise<RuntimeObjectWriteIntentExecutionContext> {
    return this.scope.run(async (client) => {
      const now = this.now();
      const result = await client.query(
        `UPDATE public.object_write_intents
            SET state = 'cancelled', terminal_at = $4, updated_at = $4,
                row_version = row_version + 1
          WHERE object_write_intent_id = $1
            AND state = $2
            AND row_version = $3`,
        [input.objectWriteIntentId, input.expectedState, input.expectedRowVersion, now],
      );
      if (result.rowCount !== 1) {
        throw new RuntimeStorageRegistryError(
          'duplicate-conflict',
          'object-write-intent-cancel-conflict',
          409,
        );
      }
      const context = await this.readExecutionContext(client, input.objectWriteIntentId, true);
      if (context === null) {
        throw new RuntimeStorageRegistryError('internal', 'write-intent-missing', 500);
      }
      return context;
    });
  }

  async failObjectUpload(objectWriteIntentId: string): Promise<boolean> {
    return this.scope.run(async (client) => {
      const now = this.now();
      const result = await client.query(
        `UPDATE public.object_write_intents
            SET state = 'failed', terminal_at = $2, updated_at = $2,
                row_version = row_version + 1
          WHERE object_write_intent_id = $1
            AND state IN ('accepted', 'uploading')`,
        [objectWriteIntentId, now],
      );
      return result.rowCount === 1;
    });
  }

  async transitionObjectWriteIntent(input: {
    objectWriteIntentId: string;
    expectedState: ObjectWriteIntentState;
    nextState: ObjectWriteIntentState;
    expectedRowVersion: number;
  }): Promise<ObjectWriteIntentSnapshot> {
    if (!WRITE_INTENT_TRANSITIONS[input.expectedState].includes(input.nextState)) {
      throw new RuntimeStorageRegistryError('invalid-request', 'invalid-write-intent-transition', 409);
    }
    const terminal = WRITE_INTENT_TRANSITIONS[input.nextState].length === 0;
    return this.scope.run(async (client) => {
      const result = await client.query<WriteIntentRow>(
        `UPDATE public.object_write_intents
            SET state = $4, terminal_at = CASE WHEN $5 THEN $6 ELSE terminal_at END,
                updated_at = $6, row_version = row_version + 1
          WHERE object_write_intent_id = $1 AND state = $2 AND row_version = $3
          RETURNING object_write_intent_id, storage_object_id, state, expires_at, terminal_at,
                    row_version, created_at, updated_at`,
        [
          input.objectWriteIntentId,
          input.expectedState,
          input.expectedRowVersion,
          input.nextState,
          terminal,
          this.now(),
        ],
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw new RuntimeStorageRegistryError('duplicate-conflict', 'write-intent-version-conflict', 409);
      }
      return this.mapIntent(row);
    });
  }

  async getStorageObject(storageObjectId: string): Promise<StorageObjectSnapshot | null> {
    return this.scope.run(async (client) => {
      const result = await client.query<{ storage_object_id: string }>(
        'SELECT storage_object_id FROM public.storage_objects WHERE storage_object_id = $1',
        [storageObjectId],
      );
      return result.rows[0] === undefined ? null : this.readObject(client, storageObjectId);
    });
  }

  async updateCopyState(input: {
    storageObjectCopyId: string;
    expectedState: StorageObjectCopyState;
    nextState: StorageObjectCopyState;
    expectedRowVersion: number;
    observedChecksumSha256?: string;
    observedByteLength?: number;
    verifiedAt?: Date;
  }): Promise<StorageObjectCopySnapshot> {
    if (!COPY_TRANSITIONS[input.expectedState].includes(input.nextState)) {
      throw new RuntimeStorageRegistryError('invalid-request', 'invalid-copy-state-transition', 409);
    }
    if (input.observedChecksumSha256 !== undefined) {
      requireSha256(input.observedChecksumSha256, 'observed-checksum-sha256');
    }
    return this.scope.run(async (client) => {
      const now = this.now();
      const result = await client.query<StorageObjectCopyRow>(
        `UPDATE public.storage_object_copies
            SET copy_state = $4,
                observed_checksum_sha256 = COALESCE($5, observed_checksum_sha256),
                observed_byte_length = COALESCE($6, observed_byte_length),
                latest_verified_at = COALESCE($7, latest_verified_at),
                absent_at = CASE WHEN $4 IN ('missing', 'deleted') THEN $8 ELSE absent_at END,
                deleted_at = CASE WHEN $4 = 'deleted' THEN $8 ELSE deleted_at END,
                updated_at = $8,
                row_version = row_version + 1
          WHERE storage_object_copy_id = $1 AND copy_state = $2 AND row_version = $3
          RETURNING storage_object_copy_id, storage_object_id, provider_role, copy_state,
                    observed_checksum_sha256, observed_byte_length, latest_verified_at,
                    row_version, updated_at`,
        [
          input.storageObjectCopyId,
          input.expectedState,
          input.expectedRowVersion,
          input.nextState,
          input.observedChecksumSha256 ?? null,
          input.observedByteLength ?? null,
          input.verifiedAt ?? null,
          now,
        ],
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw new RuntimeStorageRegistryError('duplicate-conflict', 'copy-version-conflict', 409);
      }
      return this.mapCopy(row);
    });
  }

  protected async readIntent(
    client: PostgresQueryable,
    id: string,
  ): Promise<ObjectWriteIntentSnapshot> {
    const result = await client.query<WriteIntentRow>(
      `SELECT object_write_intent_id, storage_object_id, state, expires_at, terminal_at,
              row_version, created_at, updated_at
         FROM public.object_write_intents
        WHERE object_write_intent_id = $1`,
      [id],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new RuntimeStorageRegistryError('internal', 'write-intent-missing', 500);
    }
    return this.mapIntent(row);
  }

  protected mapIntent(row: WriteIntentRow): ObjectWriteIntentSnapshot {
    return Object.freeze({
      objectWriteIntentId: row.object_write_intent_id,
      storageObjectId: row.storage_object_id,
      state: row.state,
      expiresAt: asIso(row.expires_at),
      ...(optionalIso(row.terminal_at) === undefined
        ? {}
        : { terminalAt: optionalIso(row.terminal_at) as string }),
      rowVersion: row.row_version,
      createdAt: asIso(row.created_at),
      updatedAt: asIso(row.updated_at),
    });
  }

  protected async readExecutionContext(
    client: PostgresQueryable,
    id: string,
    lock: boolean,
  ): Promise<RuntimeObjectWriteIntentExecutionContext | null> {
    const authority = await client.query<{ configuration_version_id: string | null }>(
      'SELECT configuration_version_id FROM public.object_write_intents WHERE object_write_intent_id = $1',
      [id],
    );
    const authorityRow = authority.rows[0];
    if (authorityRow === undefined) return null;
    if (authorityRow.configuration_version_id !== null) {
      return this.readConfiguredExecutionContext(client, id, lock);
    }
    const result = await client.query<WriteIntentExecutionRow>(
      `SELECT intent.object_write_intent_id, intent.storage_object_id, intent.managed_app_id,
              managed_app.app_id AS caller_app_id, intent.caller_service_id,
              intent.storage_profile_id, profile.version AS storage_profile_version,
              intent.storage_profile_fingerprint, intent.storage_prefix_class_id,
              intent.app_correlation_ref, intent.source_reference, intent.expected_content_type,
              intent.expected_byte_length, intent.expected_checksum_sha256, intent.state,
              intent.expires_at, intent.terminal_at, intent.row_version,
              intent.created_at, intent.updated_at, object_record.registry_state,
              object_record.object_protection_stage, object_record.row_version AS object_row_version,
              hot_copy.storage_object_copy_id AS hot_storage_object_copy_id,
              hot_copy.storage_profile_provider_binding_id AS hot_provider_binding_id,
              hot_copy.copy_state AS hot_copy_state, hot_copy.row_version AS hot_copy_row_version,
              hot_copy.internal_locator AS hot_internal_locator,
              canonical_copy.storage_object_copy_id AS canonical_storage_object_copy_id,
              canonical_copy.storage_profile_provider_binding_id AS canonical_provider_binding_id,
              canonical_copy.copy_state AS canonical_copy_state,
              canonical_copy.row_version AS canonical_copy_row_version,
              canonical_copy.internal_locator AS canonical_internal_locator
         FROM public.object_write_intents AS intent
         JOIN public.managed_apps AS managed_app ON managed_app.id = intent.managed_app_id
         JOIN public.storage_profiles AS profile ON profile.id = intent.storage_profile_id
         JOIN public.storage_objects AS object_record
           ON object_record.storage_object_id = intent.storage_object_id
         JOIN public.storage_object_copies AS hot_copy
           ON hot_copy.storage_object_id = intent.storage_object_id
          AND hot_copy.provider_role = 'hot'
         JOIN public.storage_object_copies AS canonical_copy
           ON canonical_copy.storage_object_id = intent.storage_object_id
          AND canonical_copy.provider_role = 'canonical'
        WHERE intent.object_write_intent_id = $1
        ${lock ? 'FOR UPDATE OF intent, object_record' : ''}`,
      [id],
    );
    const row = result.rows[0];
    return row === undefined ? null : this.mapExecutionContext(row);
  }

  protected async readConfiguredExecutionContext(
    client: PostgresQueryable,
    id: string,
    lock: boolean,
  ): Promise<ConfiguredObjectWriteIntentExecutionContext | null> {
    const base = await client.query<ConfiguredExecutionBaseRow>(
      `SELECT intent.object_write_intent_id, intent.storage_object_id,
              intent.storage_control_client_id, client.client_id AS caller_app_id,
              intent.caller_service_id, intent.configuration_version_id,
              intent.configuration_fingerprint, intent.configuration_route_id,
              intent.app_correlation_ref, intent.source_reference, intent.expected_content_type,
              intent.expected_byte_length, intent.expected_checksum_sha256, intent.state,
              intent.expires_at, intent.terminal_at, intent.row_version, intent.created_at,
              intent.updated_at, object_record.registry_state,
              object_record.object_protection_stage, object_record.row_version AS object_row_version
         FROM public.object_write_intents AS intent
         JOIN public.storage_control_clients AS client
           ON client.id = intent.storage_control_client_id
         JOIN public.storage_objects AS object_record
           ON object_record.storage_object_id = intent.storage_object_id
        WHERE intent.object_write_intent_id = $1
        ${lock ? 'FOR UPDATE OF intent, object_record' : ''}`,
      [id],
    );
    const row = base.rows[0];
    if (row === undefined) return null;
    const copiesResult = await client.query<ConfiguredExecutionCopyRow>(
      `SELECT copy.storage_object_copy_id, copy.configuration_route_target_id,
              copy.configuration_vault_id, copy.provider_connection_id,
              copy.target_role, copy.target_order, copy.copy_state,
              copy.row_version AS copy_row_version, copy.internal_locator,
              connection.provider_type, vault.bucket_label, vault.prefix_template,
              connection.secret_reference_id
         FROM public.storage_object_copies AS copy
         JOIN public.storage_control_configuration_route_targets AS target
           ON target.id = copy.configuration_route_target_id
         JOIN public.storage_control_configuration_vaults AS vault
           ON vault.id = copy.configuration_vault_id
          AND vault.storage_control_client_id = target.storage_control_client_id
          AND vault.configuration_version_id = target.configuration_version_id
         JOIN public.storage_control_provider_connections AS connection
           ON connection.id = copy.provider_connection_id
          AND connection.storage_control_client_id = target.storage_control_client_id
        WHERE copy.storage_object_id = $1
          AND copy.configuration_route_target_id IS NOT NULL
        ORDER BY CASE copy.target_role WHEN 'primary' THEN 0 ELSE 1 END,
                 copy.target_order, copy.storage_object_copy_id`,
      [row.storage_object_id],
    );
    const copies: ConfiguredProviderCopyExecutionContext[] = copiesResult.rows.map((copy) =>
      Object.freeze({
        storageObjectCopyId: copy.storage_object_copy_id,
        configurationRouteTargetId: copy.configuration_route_target_id,
        configurationVaultId: copy.configuration_vault_id,
        providerConnectionId: copy.provider_connection_id,
        role: copy.target_role,
        order: copy.target_order,
        providerType: copy.provider_type,
        bucketLabel: copy.bucket_label,
        prefixTemplate: copy.prefix_template,
        secretReferenceId: copy.secret_reference_id,
        internalLocator: copy.internal_locator,
        state: copy.copy_state,
        rowVersion: copy.copy_row_version,
      }),
    );
    const primary = copies.filter((copy) => copy.role === 'primary');
    if (primary.length !== 1) {
      throw new RuntimeStorageRegistryError('internal', 'configuration-copy-set-incomplete', 500);
    }
    const firstReplica = copies.find((copy) => copy.role === 'replica') ?? primary[0];
    const primaryCopy = primary[0];
    if (primaryCopy === undefined || firstReplica === undefined) {
      throw new RuntimeStorageRegistryError('internal', 'configuration-copy-set-incomplete', 500);
    }
    const context: ConfiguredObjectWriteIntentExecutionContext = {
      authorityKind: 'configuration',
      objectWriteIntentId: row.object_write_intent_id,
      storageObjectId: row.storage_object_id,
      storageControlClientId: row.storage_control_client_id,
      callerAppId: row.caller_app_id,
      configurationVersionId: row.configuration_version_id,
      configurationFingerprint: row.configuration_fingerprint,
      configurationRouteId: row.configuration_route_id,
      appCorrelationReference: row.app_correlation_ref,
      sourceReference: row.source_reference,
      expectedContentType: row.expected_content_type,
      expectedByteLength: asNumber(row.expected_byte_length),
      expectedChecksumSha256: row.expected_checksum_sha256,
      state: row.state,
      expiresAt: asIso(row.expires_at),
      rowVersion: row.row_version,
      objectRowVersion: row.object_row_version,
      registryState: row.registry_state,
      objectProtectionStage: row.object_protection_stage,
      configuredCopies: Object.freeze(copies),
      internalLocators: Object.freeze({
        hot: firstReplica.internalLocator,
        canonical: primaryCopy.internalLocator,
      }),
    };
    if (row.caller_service_id !== null) context.callerServiceId = row.caller_service_id;
    return Object.freeze(context);
  }

  protected mapExecutionContext(
    row: WriteIntentExecutionRow,
  ): ObjectWriteIntentExecutionContext {
    const context: ObjectWriteIntentExecutionContext = {
      authorityKind: 'legacy-profile',
      objectWriteIntentId: row.object_write_intent_id,
      storageObjectId: row.storage_object_id,
      managedAppId: row.managed_app_id,
      callerAppId: row.caller_app_id,
      storageProfileId: row.storage_profile_id,
      storageProfileVersion: row.storage_profile_version,
      storageProfileFingerprint: row.storage_profile_fingerprint,
      storagePrefixClassId: row.storage_prefix_class_id,
      appCorrelationReference: row.app_correlation_ref,
      sourceReference: row.source_reference,
      expectedContentType: row.expected_content_type,
      expectedByteLength: asNumber(row.expected_byte_length),
      expectedChecksumSha256: row.expected_checksum_sha256,
      state: row.state,
      expiresAt: asIso(row.expires_at),
      rowVersion: row.row_version,
      objectRowVersion: row.object_row_version,
      registryState: row.registry_state,
      objectProtectionStage: row.object_protection_stage,
      internalLocators: Object.freeze({
        hot: row.hot_internal_locator,
        canonical: row.canonical_internal_locator,
      }),
      providerCopies: Object.freeze({
        hot: Object.freeze({
          storageObjectCopyId: row.hot_storage_object_copy_id,
          providerBindingId: row.hot_provider_binding_id,
          providerRole: 'hot' as const,
          state: row.hot_copy_state,
          rowVersion: row.hot_copy_row_version,
          internalLocator: row.hot_internal_locator,
        }),
        canonical: Object.freeze({
          storageObjectCopyId: row.canonical_storage_object_copy_id,
          providerBindingId: row.canonical_provider_binding_id,
          providerRole: 'canonical' as const,
          state: row.canonical_copy_state,
          rowVersion: row.canonical_copy_row_version,
          internalLocator: row.canonical_internal_locator,
        }),
      }),
    };
    if (row.caller_service_id !== null) context.callerServiceId = row.caller_service_id;
    return Object.freeze(context);
  }

  protected async readObject(
    client: PostgresQueryable,
    id: string,
  ): Promise<StorageObjectSnapshot> {
    const objectResult = await client.query<StorageObjectRow>(
      `SELECT storage_object_id, configuration_route_id, registry_state, object_protection_stage,
              expected_checksum_sha256, expected_byte_length, expected_content_type,
              verified_checksum_sha256, verified_byte_length, safe_technical_metadata, row_version,
              created_at, updated_at
         FROM public.storage_objects
        WHERE storage_object_id = $1`,
      [id],
    );
    const objectRow = objectResult.rows[0];
    if (objectRow === undefined) {
      throw new RuntimeStorageRegistryError('internal', 'storage-object-missing', 500);
    }
    const copyResult = await client.query<RuntimeCopyRow>(
      `SELECT storage_object_copy_id, storage_object_id, provider_role,
              configuration_route_target_id, target_role, target_order, copy_state,
              observed_checksum_sha256, observed_byte_length, latest_verified_at,
              row_version, updated_at
         FROM public.storage_object_copies
        WHERE storage_object_id = $1
        ORDER BY CASE target_role WHEN 'replica' THEN 0 WHEN 'primary' THEN 1 ELSE 2 END,
                 target_order, provider_role`,
      [id],
    );
    const configuredRows = copyResult.rows.filter((row) => row.configuration_route_target_id !== null);
    let hot: StorageObjectCopySnapshot;
    let canonical: StorageObjectCopySnapshot;
    let configuredCopies: readonly Readonly<ConfiguredStorageObjectCopySnapshot>[] | undefined;
    if (configuredRows.length > 0) {
      const mapped = configuredRows.map((row) => this.mapConfiguredCopy(row));
      const primary = mapped.find((copy) => copy.role === 'primary');
      if (primary === undefined) {
        throw new RuntimeStorageRegistryError('internal', 'storage-object-copy-set-incomplete', 500);
      }
      const firstReplica = mapped.find((copy) => copy.role === 'replica') ?? primary;
      canonical = this.compatibilityCopy(primary, 'canonical');
      hot = this.compatibilityCopy(firstReplica, 'hot');
      configuredCopies = Object.freeze(mapped);
    } else {
      const legacy = new Map(copyResult.rows.flatMap((row) =>
        row.provider_role === null
          ? []
          : [[row.provider_role, this.mapCopy(row as StorageObjectCopyRow)] as const],
      ));
      const legacyHot = legacy.get('hot');
      const legacyCanonical = legacy.get('canonical');
      if (legacyHot === undefined || legacyCanonical === undefined) {
        throw new RuntimeStorageRegistryError('internal', 'storage-object-copy-set-incomplete', 500);
      }
      hot = legacyHot;
      canonical = legacyCanonical;
    }
    return Object.freeze({
      storageObjectId: objectRow.storage_object_id,
      registryState: objectRow.registry_state,
      objectProtectionStage: objectRow.object_protection_stage,
      expectedChecksumSha256: objectRow.expected_checksum_sha256,
      expectedByteLength: asNumber(objectRow.expected_byte_length),
      expectedContentType: objectRow.expected_content_type,
      ...(objectRow.verified_checksum_sha256 === null
        ? {}
        : { verifiedChecksumSha256: objectRow.verified_checksum_sha256 }),
      ...(objectRow.verified_byte_length === null
        ? {}
        : { verifiedByteLength: asNumber(objectRow.verified_byte_length) }),
      safeTechnicalMetadata: Object.freeze({ ...objectRow.safe_technical_metadata }),
      rowVersion: objectRow.row_version,
      createdAt: asIso(objectRow.created_at),
      updatedAt: asIso(objectRow.updated_at),
      copies: Object.freeze({ hot, canonical }),
      ...(configuredCopies === undefined ? {} : { configuredCopies }),
    });
  }

  protected mapConfiguredCopy(row: RuntimeCopyRow): ConfiguredStorageObjectCopySnapshot {
    if (row.configuration_route_target_id === null || row.target_role === null || row.target_order === null) {
      throw new RuntimeStorageRegistryError('internal', 'configuration-copy-authority-missing', 500);
    }
    return Object.freeze({
      storageObjectCopyId: row.storage_object_copy_id,
      configurationRouteTargetId: row.configuration_route_target_id,
      role: row.target_role,
      order: row.target_order,
      state: row.copy_state,
      ...(row.observed_checksum_sha256 === null ? {} : { observedChecksumSha256: row.observed_checksum_sha256 }),
      ...(row.observed_byte_length === null ? {} : { observedByteLength: asNumber(row.observed_byte_length) }),
      ...(optionalIso(row.latest_verified_at) === undefined ? {} : { latestVerifiedAt: optionalIso(row.latest_verified_at) as string }),
      rowVersion: row.row_version,
      updatedAt: asIso(row.updated_at),
    });
  }

  protected compatibilityCopy(
    copy: Readonly<ConfiguredStorageObjectCopySnapshot>,
    providerRole: ProviderRole,
  ): StorageObjectCopySnapshot {
    return Object.freeze({
      storageObjectCopyId: copy.storageObjectCopyId,
      providerRole,
      state: copy.state,
      ...(copy.observedChecksumSha256 === undefined ? {} : { observedChecksumSha256: copy.observedChecksumSha256 }),
      ...(copy.observedByteLength === undefined ? {} : { observedByteLength: copy.observedByteLength }),
      ...(copy.latestVerifiedAt === undefined ? {} : { latestVerifiedAt: copy.latestVerifiedAt }),
      rowVersion: copy.rowVersion,
      updatedAt: copy.updatedAt,
    });
  }

  protected mapCopy(row: StorageObjectCopyRow): StorageObjectCopySnapshot {
    return Object.freeze({
      storageObjectCopyId: row.storage_object_copy_id,
      providerRole: row.provider_role,
      state: row.copy_state,
      ...(row.observed_checksum_sha256 === null
        ? {}
        : { observedChecksumSha256: row.observed_checksum_sha256 }),
      ...(row.observed_byte_length === null
        ? {}
        : { observedByteLength: asNumber(row.observed_byte_length) }),
      ...(optionalIso(row.latest_verified_at) === undefined
        ? {}
        : { latestVerifiedAt: optionalIso(row.latest_verified_at) as string }),
      rowVersion: row.row_version,
      updatedAt: asIso(row.updated_at),
    });
  }
}
