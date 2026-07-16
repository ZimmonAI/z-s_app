import { PostgresRuntimeStorageRegistryDuplicateCore } from './runtime-storage-registry-duplicate.js';
import {
  RuntimeStorageRegistryError,
  type CreateObjectWriteIntentInput,
  type ObjectWriteIntentExecutionContext,
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
} from './runtime-storage-registry-support.js';

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
  ): Promise<ObjectWriteIntentExecutionContext | null> {
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
  }): Promise<ObjectWriteIntentExecutionContext> {
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
  }): Promise<ObjectWriteIntentExecutionContext> {
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
  }): Promise<ObjectWriteIntentExecutionContext> {
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
  ): Promise<ObjectWriteIntentExecutionContext | null> {
    const result = await client.query<WriteIntentExecutionRow>(
      `SELECT intent.object_write_intent_id, intent.storage_object_id, intent.managed_app_id,
              managed_app.app_id AS caller_app_id, intent.caller_service_id,
              intent.storage_profile_id, profile.version AS storage_profile_version,
              intent.storage_profile_fingerprint, intent.storage_prefix_class_id,
              intent.app_correlation_ref, intent.source_reference, intent.expected_content_type,
              intent.expected_byte_length, intent.expected_checksum_sha256, intent.state,
              intent.expires_at, intent.terminal_at, intent.row_version,
              intent.created_at, intent.updated_at, object_record.registry_state,
              object_record.object_protection_stage,
              hot_copy.internal_locator AS hot_internal_locator,
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

  protected mapExecutionContext(
    row: WriteIntentExecutionRow,
  ): ObjectWriteIntentExecutionContext {
    const context: ObjectWriteIntentExecutionContext = {
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
      registryState: row.registry_state,
      objectProtectionStage: row.object_protection_stage,
      internalLocators: Object.freeze({
        hot: row.hot_internal_locator,
        canonical: row.canonical_internal_locator,
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
      `SELECT storage_object_id, registry_state, object_protection_stage,
              expected_checksum_sha256, expected_byte_length, expected_content_type,
              verified_checksum_sha256, verified_byte_length, row_version,
              created_at, updated_at
         FROM public.storage_objects
        WHERE storage_object_id = $1`,
      [id],
    );
    const objectRow = objectResult.rows[0];
    if (objectRow === undefined) {
      throw new RuntimeStorageRegistryError('internal', 'storage-object-missing', 500);
    }
    const copyResult = await client.query<StorageObjectCopyRow>(
      `SELECT storage_object_copy_id, storage_object_id, provider_role, copy_state,
              observed_checksum_sha256, observed_byte_length, latest_verified_at,
              row_version, updated_at
         FROM public.storage_object_copies
        WHERE storage_object_id = $1
        ORDER BY provider_role`,
      [id],
    );
    const copies = new Map(copyResult.rows.map((row) => [row.provider_role, this.mapCopy(row)]));
    const hot = copies.get('hot');
    const canonical = copies.get('canonical');
    if (hot === undefined || canonical === undefined) {
      throw new RuntimeStorageRegistryError('internal', 'storage-object-copy-set-incomplete', 500);
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
      rowVersion: objectRow.row_version,
      createdAt: asIso(objectRow.created_at),
      updatedAt: asIso(objectRow.updated_at),
      copies: Object.freeze({ hot, canonical }),
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
