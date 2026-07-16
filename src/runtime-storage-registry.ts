import type {
  ObjectUploadCompletionOperationResult,
  SafeDiagnostic,
  SafeProviderCopyResult,
  StorageObjectResultState,
} from './runtime-contract.js';
import type {
  DualProviderAttemptReservation,
  DualProviderStorageTruth,
  DualProviderWriteOutcome,
  TargetedProviderRetryReservation,
} from './runtime-dual-provider.js';
import { PostgresRuntimeStorageRegistryObjectCore } from './runtime-storage-registry-object.js';
import {
  RuntimeStorageRegistryError,
  type DurableDuplicateResultCodec,
  type DurableDuplicateResultReference,
  type PostgresQueryable,
  type ProviderAttemptInput,
  type ProviderAttemptRow,
  type ReconciliationIssueInput,
  type ReconciliationIssueRow,
  type SafeStorageEventInput,
} from './runtime-storage-registry-types.js';
import {
  asIso,
  asNumber,
  assertSafeJsonObject,
  requireUuid,
} from './runtime-storage-registry-support.js';

export * from './runtime-storage-registry-types.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function createRuntimeStorageDuplicateResultCodec(): DurableDuplicateResultCodec {
  return Object.freeze({
    async encode(value: unknown, _client: PostgresQueryable) {
      if (!isRecord(value)) {
        throw new RuntimeStorageRegistryError('internal', 'invalid-idempotency-result', 500);
      }
      const writeIntentId = requireUuid(
        typeof value.writeIntentId === 'string' ? value.writeIntentId : '',
        'duplicate-result-write-intent',
      );
      const storageObjectId = requireUuid(
        typeof value.storageObjectId === 'string' ? value.storageObjectId : '',
        'duplicate-result-storage-object',
      );
      let resultKind: string;
      if (value.state === 'accepted') resultKind = 'object-write-intent';
      else if (value.state === 'recorded') resultKind = 'object-upload-completion';
      else if (value.state === 'cancelled') resultKind = 'object-write-intent-cancel';
      else {
        throw new RuntimeStorageRegistryError('internal', 'unsupported-idempotency-result', 500);
      }
      return Object.freeze({
        resultKind,
        resultReferenceId: writeIntentId,
        storageObjectId,
      });
    },

    async decode(reference: DurableDuplicateResultReference, client: PostgresQueryable) {
      const writeIntentId = requireUuid(
        reference.resultReferenceId,
        'duplicate-result-reference',
      );
      const storageObjectId = requireUuid(
        reference.storageObjectId ?? '',
        'duplicate-result-storage-object',
      );
      if (reference.resultKind === 'object-write-intent') {
        const result = await client.query<{
          object_write_intent_id: string;
          storage_object_id: string;
          expires_at: Date | string;
        }>(
          `SELECT intent.object_write_intent_id, intent.storage_object_id, intent.expires_at
             FROM public.object_write_intents AS intent
            WHERE intent.object_write_intent_id = $1
              AND intent.storage_object_id = $2`,
          [writeIntentId, storageObjectId],
        );
        const row = result.rows[0];
        if (row === undefined) {
          throw new RuntimeStorageRegistryError('internal', 'idempotency-result-missing', 500);
        }
        return Object.freeze({
          writeIntentId: row.object_write_intent_id,
          storageObjectId: row.storage_object_id,
          state: 'accepted' as const,
          expiresAt: asIso(row.expires_at),
          objectProtectionStage: 'write-intent-created' as const,
        });
      }
      if (reference.resultKind === 'object-upload-completion') {
        const result = await client.query<{
          object_write_intent_id: string;
          storage_object_id: string;
          state: string;
          expected_checksum_sha256: string;
          expected_byte_length: string | number;
          object_protection_stage: string;
          registry_state: 'reserved' | 'active' | 'degraded';
          safe_technical_metadata: Record<string, unknown>;
          hot_copy_state: 'pending' | 'verified' | 'failed';
          canonical_copy_state: 'pending' | 'verified' | 'failed';
        }>(
          `SELECT intent.object_write_intent_id, intent.storage_object_id, intent.state,
                  object_record.expected_checksum_sha256,
                  object_record.expected_byte_length,
                  object_record.object_protection_stage,
                  object_record.registry_state,
                  object_record.safe_technical_metadata,
                  hot_copy.copy_state AS hot_copy_state,
                  canonical_copy.copy_state AS canonical_copy_state
             FROM public.object_write_intents AS intent
             JOIN public.storage_objects AS object_record
               ON object_record.storage_object_id = intent.storage_object_id
             JOIN public.storage_object_copies AS hot_copy
               ON hot_copy.storage_object_id = intent.storage_object_id
              AND hot_copy.provider_role = 'hot'
             JOIN public.storage_object_copies AS canonical_copy
               ON canonical_copy.storage_object_id = intent.storage_object_id
              AND canonical_copy.provider_role = 'canonical'
            WHERE intent.object_write_intent_id = $1
              AND intent.storage_object_id = $2`,
          [writeIntentId, storageObjectId],
        );
        const row = result.rows[0];
        if (row === undefined || row.state !== 'completed') {
          throw new RuntimeStorageRegistryError('internal', 'idempotency-result-missing', 500);
        }
        const base = {
          storageObjectId: row.storage_object_id,
          writeIntentId: row.object_write_intent_id,
          state: 'recorded' as const,
          checksumSha256: row.expected_checksum_sha256,
          byteLength: asNumber(row.expected_byte_length),
          integrityVerification: Object.freeze({
            verified: true as const,
            checksumVerified: true as const,
            sizeVerified: true,
            sizeVerificationDisposition: 'matched' as const,
          }),
          objectProtectionStage: row.object_protection_stage,
        };
        if (row.object_protection_stage === 'upload-completion-recorded') {
          return Object.freeze(base);
        }
        const media = row.safe_technical_metadata.media;
        const completion = row.safe_technical_metadata.completion;
        if (!isRecord(media) || typeof media.mediaType !== 'string' ||
            (media.mediaFamily !== 'image' && media.mediaFamily !== 'video')) {
          throw new RuntimeStorageRegistryError('internal', 'idempotency-media-result-missing', 500);
        }
        if (!isRecord(completion) ||
            (completion.storageState !== 'ready' &&
             completion.storageState !== 'degraded' &&
             completion.storageState !== 'unavailable') ||
            !isRecord(completion.copies)) {
          throw new RuntimeStorageRegistryError('internal', 'idempotency-completion-result-missing', 500);
        }
        const completionCopies = completion.copies;
        const parseCopy = (role: 'hot' | 'canonical'): Readonly<SafeProviderCopyResult> => {
          const value = completionCopies[role];
          if (!isRecord(value) ||
              (value.state !== 'verified' && value.state !== 'failed') ||
              typeof value.retryable !== 'boolean') {
            throw new RuntimeStorageRegistryError('internal', 'idempotency-copy-result-missing', 500);
          }
          return Object.freeze({ state: value.state, retryable: value.retryable });
        };
        const safeDiagnostic = completion.safeDiagnostic;
        if (safeDiagnostic !== undefined &&
            (!isRecord(safeDiagnostic) ||
             typeof safeDiagnostic.category !== 'string' ||
             typeof safeDiagnostic.code !== 'string' ||
             typeof safeDiagnostic.retryable !== 'boolean')) {
          throw new RuntimeStorageRegistryError('internal', 'idempotency-diagnostic-result-invalid', 500);
        }
        return Object.freeze({
          ...base,
          storageState: completion.storageState,
          verifiedMedia: Object.freeze({ ...media }),
          copies: Object.freeze({ hot: parseCopy('hot'), canonical: parseCopy('canonical') }),
          ...(safeDiagnostic === undefined
            ? {}
            : { safeDiagnostic: Object.freeze({ ...safeDiagnostic }) }),
        });
      }
      if (reference.resultKind === 'object-write-intent-cancel') {
        const result = await client.query<{
          object_write_intent_id: string;
          storage_object_id: string;
          state: string;
        }>(
          `SELECT object_write_intent_id, storage_object_id, state
             FROM public.object_write_intents
            WHERE object_write_intent_id = $1
              AND storage_object_id = $2`,
          [writeIntentId, storageObjectId],
        );
        const row = result.rows[0];
        if (row === undefined || row.state !== 'cancelled') {
          throw new RuntimeStorageRegistryError('internal', 'idempotency-result-missing', 500);
        }
        return Object.freeze({
          storageObjectId: row.storage_object_id,
          writeIntentId: row.object_write_intent_id,
          state: 'cancelled' as const,
        });
      }
      throw new RuntimeStorageRegistryError('internal', 'unsupported-idempotency-result-kind', 500);
    },
  });
}


const PROVIDER_ROLES = ['hot', 'canonical'] as const;

function providerCopyResult(
  outcome: Readonly<DualProviderWriteOutcome>,
): Readonly<SafeProviderCopyResult> {
  return Object.freeze({ state: outcome.state, retryable: outcome.retryable });
}

function deriveStorageMapping(states: Readonly<Record<'hot' | 'canonical', 'verified' | 'failed'>>): {
  storageState: StorageObjectResultState;
  registryState: 'active' | 'degraded' | 'reserved';
  objectProtectionStage: string;
} {
  if (states.hot === 'verified' && states.canonical === 'verified') {
    return {
      storageState: 'ready',
      registryState: 'active',
      objectProtectionStage: 'canonical-and-hot-verified',
    };
  }
  if (states.hot === 'failed' && states.canonical === 'verified') {
    return {
      storageState: 'degraded',
      registryState: 'degraded',
      objectProtectionStage: 'canonical-verified-hot-repair-required',
    };
  }
  if (states.hot === 'verified' && states.canonical === 'failed') {
    return {
      storageState: 'degraded',
      registryState: 'degraded',
      objectProtectionStage: 'hot-verified-canonical-repair-required',
    };
  }
  return {
    storageState: 'unavailable',
    registryState: 'reserved',
    objectProtectionStage: 'provider-write-failed',
  };
}

function safeOutcomeDiagnostic(
  mapping: ReturnType<typeof deriveStorageMapping>,
): Readonly<SafeDiagnostic> | undefined {
  if (mapping.storageState === 'ready') return undefined;
  return Object.freeze({
    category: 'dependency-unavailable',
    code:
      mapping.storageState === 'unavailable'
        ? 'provider-write-unavailable'
        : 'provider-write-degraded',
    retryable: true,
  });
}

export class PostgresRuntimeStorageRegistry extends PostgresRuntimeStorageRegistryObjectCore {
  async beginDualProviderWrite(input: {
    objectWriteIntentId: string;
    storageObjectId: string;
    expectedIntentRowVersion: number;
    expectedObjectRowVersion: number;
    expectedChecksumSha256: string;
    expectedByteLength: number;
    copies: Readonly<Record<'hot' | 'canonical', Readonly<{
      storageObjectCopyId: string;
      providerBindingId: string;
      providerRole: 'hot' | 'canonical';
      state: string;
      rowVersion: number;
      internalLocator: string;
    }>>>;
  }): Promise<Readonly<DualProviderAttemptReservation>> {
    requireUuid(input.objectWriteIntentId, 'dual-provider-write-intent');
    requireUuid(input.storageObjectId, 'dual-provider-storage-object');
    return this.scope.run(async (client) => {
      const locked = await client.query<{
        intent_row_version: number;
        object_row_version: number;
        expected_checksum_sha256: string;
        expected_byte_length: string | number;
      }>(
        `SELECT intent.row_version AS intent_row_version,
                object_record.row_version AS object_row_version,
                object_record.expected_checksum_sha256,
                object_record.expected_byte_length
           FROM public.object_write_intents AS intent
           JOIN public.storage_objects AS object_record
             ON object_record.storage_object_id = intent.storage_object_id
          WHERE intent.object_write_intent_id = $1
            AND intent.storage_object_id = $2
            AND intent.state = 'uploading'
          FOR UPDATE OF intent, object_record`,
        [input.objectWriteIntentId, input.storageObjectId],
      );
      const row = locked.rows[0];
      if (
        row === undefined ||
        row.intent_row_version !== input.expectedIntentRowVersion ||
        row.object_row_version !== input.expectedObjectRowVersion ||
        row.expected_checksum_sha256 !== input.expectedChecksumSha256 ||
        asNumber(row.expected_byte_length) !== input.expectedByteLength
      ) {
        throw new RuntimeStorageRegistryError(
          'duplicate-conflict',
          'dual-provider-start-conflict',
          409,
        );
      }
      const operationReference = `object-upload-completion:${input.objectWriteIntentId}`;
      const attempts: Partial<Record<'hot' | 'canonical', {
        providerAttemptId: string;
        storageObjectCopyId: string;
        expectedCopyRowVersion: number;
      }>> = {};
      const now = this.now();
      for (const role of PROVIDER_ROLES) {
        const copy = input.copies[role];
        const copyResult = await client.query<{ n: string }>(
          `SELECT storage_object_copy_id::text AS n
             FROM public.storage_object_copies
            WHERE storage_object_copy_id = $1
              AND storage_object_id = $2
              AND provider_role = $3
              AND storage_profile_provider_binding_id = $4
              AND internal_locator = $5
              AND copy_state = 'pending'
              AND row_version = $6
            FOR UPDATE`,
          [
            copy.storageObjectCopyId,
            input.storageObjectId,
            role,
            copy.providerBindingId,
            copy.internalLocator,
            copy.rowVersion,
          ],
        );
        if (copyResult.rows[0] === undefined) {
          throw new RuntimeStorageRegistryError(
            'duplicate-conflict',
            'dual-provider-copy-start-conflict',
            409,
          );
        }
        const duplicate = await client.query<{ n: string }>(
          `SELECT storage_provider_attempt_id::text AS n
             FROM public.storage_provider_attempts
            WHERE storage_object_copy_id = $1
              AND operation = 'write'
              AND operation_reference = $2
              AND attempt_number = 1`,
          [copy.storageObjectCopyId, operationReference],
        );
        if (duplicate.rows[0] !== undefined) {
          throw new RuntimeStorageRegistryError(
            'duplicate-conflict',
            'dual-provider-attempt-conflict',
            409,
          );
        }
        const providerAttemptId = this.createId();
        await client.query(
          `INSERT INTO public.storage_provider_attempts (
             storage_provider_attempt_id, storage_object_copy_id, storage_object_id,
             operation, operation_reference, attempt_number, state, retryable,
             expected_checksum_sha256, expected_byte_length, started_at, created_at, updated_at
           ) VALUES ($1, $2, $3, 'write', $4, 1, 'in_progress', false, $5, $6, $7, $7, $7)`,
          [
            providerAttemptId,
            copy.storageObjectCopyId,
            input.storageObjectId,
            operationReference,
            input.expectedChecksumSha256,
            input.expectedByteLength,
            now,
          ],
        );
        attempts[role] = {
          providerAttemptId,
          storageObjectCopyId: copy.storageObjectCopyId,
          expectedCopyRowVersion: copy.rowVersion,
        };
      }
      const hot = attempts.hot;
      const canonical = attempts.canonical;
      if (hot === undefined || canonical === undefined) {
        throw new RuntimeStorageRegistryError('internal', 'dual-provider-attempt-set-incomplete', 500);
      }
      return Object.freeze({
        objectWriteIntentId: input.objectWriteIntentId,
        storageObjectId: input.storageObjectId,
        expectedIntentRowVersion: input.expectedIntentRowVersion,
        expectedObjectRowVersion: input.expectedObjectRowVersion,
        attempts: Object.freeze({ hot: Object.freeze(hot), canonical: Object.freeze(canonical) }),
      });
    });
  }

  async completeDualProviderWrite(input: {
    reservation: Readonly<DualProviderAttemptReservation>;
    checksumSha256: string;
    byteLength: number;
    verifiedMedia: Readonly<import('./runtime-contract.js').VerifiedMediaMetadata>;
    outcomes: Readonly<Record<'hot' | 'canonical', Readonly<DualProviderWriteOutcome>>>;
  }): Promise<Readonly<ObjectUploadCompletionOperationResult>> {
    return this.scope.run(async (client) => {
      const now = this.now();
      for (const role of PROVIDER_ROLES) {
        const attempt = input.reservation.attempts[role];
        const outcome = input.outcomes[role];
        const attemptResult = await client.query(
          `UPDATE public.storage_provider_attempts
              SET state = $4, retryable = $5,
                  observed_checksum_sha256 = $6,
                  observed_byte_length = $7,
                  safe_diagnostic_category = $8,
                  safe_diagnostic_code = $9,
                  verified_at = CASE WHEN $4 = 'succeeded' THEN $10::timestamptz ELSE NULL END,
                  finished_at = $10, updated_at = $10
            WHERE storage_provider_attempt_id = $1
              AND storage_object_copy_id = $2
              AND storage_object_id = $3
              AND state = 'in_progress'`,
          [
            attempt.providerAttemptId,
            attempt.storageObjectCopyId,
            input.reservation.storageObjectId,
            outcome.state === 'verified' ? 'succeeded' : 'failed',
            outcome.retryable,
            outcome.observedChecksumSha256 ?? null,
            outcome.observedByteLength ?? null,
            outcome.diagnostic?.category ?? null,
            outcome.diagnostic?.code ?? null,
            now,
          ],
        );
        if (attemptResult.rowCount !== 1) {
          throw new RuntimeStorageRegistryError(
            'duplicate-conflict',
            'dual-provider-attempt-finish-conflict',
            409,
          );
        }
        const copyResult = await client.query(
          `UPDATE public.storage_object_copies
              SET copy_state = $4,
                  observed_checksum_sha256 = $5,
                  observed_byte_length = $6,
                  latest_verified_at = CASE WHEN $4 = 'verified' THEN $7 ELSE latest_verified_at END,
                  updated_at = $7, row_version = row_version + 1
            WHERE storage_object_copy_id = $1
              AND storage_object_id = $2
              AND copy_state = 'pending'
              AND row_version = $3`,
          [
            attempt.storageObjectCopyId,
            input.reservation.storageObjectId,
            attempt.expectedCopyRowVersion,
            outcome.state,
            outcome.observedChecksumSha256 ?? null,
            outcome.observedByteLength ?? null,
            now,
          ],
        );
        if (copyResult.rowCount !== 1) {
          throw new RuntimeStorageRegistryError(
            'duplicate-conflict',
            'dual-provider-copy-finish-conflict',
            409,
          );
        }
      }
      const mapping = deriveStorageMapping({
        hot: input.outcomes.hot.state,
        canonical: input.outcomes.canonical.state,
      });
      const diagnostic = safeOutcomeDiagnostic(mapping);
      const metadata = Object.freeze({
        media: input.verifiedMedia,
        completion: Object.freeze({
          storageState: mapping.storageState,
          copies: Object.freeze({
            hot: providerCopyResult(input.outcomes.hot),
            canonical: providerCopyResult(input.outcomes.canonical),
          }),
          ...(diagnostic === undefined ? {} : { safeDiagnostic: diagnostic }),
        }),
      });
      assertSafeJsonObject(metadata, 'safe-technical-metadata');
      const objectResult = await client.query(
        `UPDATE public.storage_objects
            SET registry_state = $3,
                object_protection_stage = $4,
                verified_checksum_sha256 = $5,
                verified_byte_length = $6,
                safe_technical_metadata = safe_technical_metadata || $7::jsonb,
                activated_at = CASE WHEN $3 IN ('active', 'degraded')
                                    THEN COALESCE(activated_at, $8) ELSE activated_at END,
                updated_at = $8, row_version = row_version + 1
          WHERE storage_object_id = $1
            AND row_version = $2
            AND expected_checksum_sha256 = $5
            AND expected_byte_length = $6`,
        [
          input.reservation.storageObjectId,
          input.reservation.expectedObjectRowVersion,
          mapping.registryState,
          mapping.objectProtectionStage,
          input.checksumSha256,
          input.byteLength,
          JSON.stringify(metadata),
          now,
        ],
      );
      if (objectResult.rowCount !== 1) {
        throw new RuntimeStorageRegistryError(
          'duplicate-conflict',
          'dual-provider-object-finish-conflict',
          409,
        );
      }
      const intentResult = await client.query(
        `UPDATE public.object_write_intents
            SET state = 'completed', terminal_at = $3, updated_at = $3,
                row_version = row_version + 1
          WHERE object_write_intent_id = $1
            AND state = 'uploading'
            AND row_version = $2`,
        [
          input.reservation.objectWriteIntentId,
          input.reservation.expectedIntentRowVersion,
          now,
        ],
      );
      if (intentResult.rowCount !== 1) {
        throw new RuntimeStorageRegistryError(
          'duplicate-conflict',
          'dual-provider-intent-finish-conflict',
          409,
        );
      }
      return Object.freeze({
        storageObjectId: input.reservation.storageObjectId,
        writeIntentId: input.reservation.objectWriteIntentId,
        state: 'recorded' as const,
        checksumSha256: input.checksumSha256,
        byteLength: input.byteLength,
        integrityVerification: Object.freeze({
          verified: true as const,
          checksumVerified: true as const,
          sizeVerified: true,
          sizeVerificationDisposition: 'matched' as const,
        }),
        objectProtectionStage: mapping.objectProtectionStage,
        storageState: mapping.storageState,
        verifiedMedia: input.verifiedMedia,
        copies: Object.freeze({
          hot: providerCopyResult(input.outcomes.hot),
          canonical: providerCopyResult(input.outcomes.canonical),
        }),
        ...(diagnostic === undefined ? {} : { safeDiagnostic: diagnostic }),
      });
    });
  }

  async abortDualProviderWrite(input: {
    reservation: Readonly<DualProviderAttemptReservation>;
    diagnostic: Readonly<SafeDiagnostic>;
  }): Promise<void> {
    await this.scope.run(async (client) => {
      const now = this.now();
      for (const role of PROVIDER_ROLES) {
        const attempt = input.reservation.attempts[role];
        await client.query(
          `UPDATE public.storage_provider_attempts
              SET state = 'failed', retryable = $4,
                  safe_diagnostic_category = $5, safe_diagnostic_code = $6,
                  finished_at = $7, updated_at = $7
            WHERE storage_provider_attempt_id = $1
              AND storage_object_copy_id = $2
              AND storage_object_id = $3
              AND state = 'in_progress'`,
          [
            attempt.providerAttemptId,
            attempt.storageObjectCopyId,
            input.reservation.storageObjectId,
            input.diagnostic.retryable,
            input.diagnostic.category,
            input.diagnostic.code,
            now,
          ],
        );
      }
    });
  }

  async reserveTargetedProviderRetry(input: {
    storageObjectId: string;
    providerRole: 'hot' | 'canonical';
    expectedFailedCopyVersion: number;
  }): Promise<Readonly<TargetedProviderRetryReservation>> {
    return this.scope.run(async (client) => {
      const result = await client.query<{
        storage_object_copy_id: string;
        storage_profile_provider_binding_id: string;
        internal_locator: string;
        copy_row_version: number;
        object_row_version: number;
        expected_checksum_sha256: string;
        expected_byte_length: string | number;
      }>(
        `SELECT copy.storage_object_copy_id,
                copy.storage_profile_provider_binding_id,
                copy.internal_locator,
                copy.row_version AS copy_row_version,
                object_record.row_version AS object_row_version,
                object_record.expected_checksum_sha256,
                object_record.expected_byte_length
           FROM public.storage_object_copies AS copy
           JOIN public.storage_objects AS object_record
             ON object_record.storage_object_id = copy.storage_object_id
          WHERE copy.storage_object_id = $1
            AND copy.provider_role = $2
            AND copy.copy_state = 'failed'
            AND copy.row_version = $3
          FOR UPDATE OF copy, object_record`,
        [input.storageObjectId, input.providerRole, input.expectedFailedCopyVersion],
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw new RuntimeStorageRegistryError(
          'duplicate-conflict',
          'targeted-retry-copy-conflict',
          409,
        );
      }
      const attemptNumberResult = await client.query<{ attempt_number: number }>(
        `SELECT COALESCE(MAX(attempt_number), 0) + 1 AS attempt_number
           FROM public.storage_provider_attempts
          WHERE storage_object_copy_id = $1
            AND operation = 'write'`,
        [row.storage_object_copy_id],
      );
      const attemptNumber = attemptNumberResult.rows[0]?.attempt_number;
      if (!Number.isSafeInteger(attemptNumber) || attemptNumber === undefined || attemptNumber <= 1) {
        throw new RuntimeStorageRegistryError('internal', 'targeted-retry-attempt-number-invalid', 500);
      }
      const now = this.now();
      const providerAttemptId = this.createId();
      await client.query(
        `INSERT INTO public.storage_provider_attempts (
           storage_provider_attempt_id, storage_object_copy_id, storage_object_id,
           operation, operation_reference, attempt_number, state, retryable,
           expected_checksum_sha256, expected_byte_length, started_at, created_at, updated_at
         ) VALUES ($1, $2, $3, 'write', $4, $5, 'in_progress', false, $6, $7, $8, $8, $8)`,
        [
          providerAttemptId,
          row.storage_object_copy_id,
          input.storageObjectId,
          `targeted-retry:${input.storageObjectId}:${input.providerRole}`,
          attemptNumber,
          row.expected_checksum_sha256,
          row.expected_byte_length,
          now,
        ],
      );
      const copyUpdate = await client.query(
        `UPDATE public.storage_object_copies
            SET copy_state = 'pending', updated_at = $4, row_version = row_version + 1
          WHERE storage_object_copy_id = $1
            AND copy_state = 'failed'
            AND row_version = $2
            AND storage_object_id = $3`,
        [row.storage_object_copy_id, input.expectedFailedCopyVersion, input.storageObjectId, now],
      );
      if (copyUpdate.rowCount !== 1) {
        throw new RuntimeStorageRegistryError(
          'duplicate-conflict',
          'targeted-retry-copy-conflict',
          409,
        );
      }
      return Object.freeze({
        storageObjectId: input.storageObjectId,
        providerRole: input.providerRole,
        providerBindingId: row.storage_profile_provider_binding_id,
        internalLocator: row.internal_locator,
        providerAttemptId,
        storageObjectCopyId: row.storage_object_copy_id,
        expectedPendingCopyVersion: input.expectedFailedCopyVersion + 1,
        expectedObjectRowVersion: row.object_row_version,
        checksumSha256: row.expected_checksum_sha256,
        byteLength: asNumber(row.expected_byte_length),
      });
    });
  }

  async completeTargetedProviderRetry(input: {
    reservation: Readonly<TargetedProviderRetryReservation>;
    outcome: Readonly<DualProviderWriteOutcome>;
  }): Promise<Readonly<DualProviderStorageTruth>> {
    return this.scope.run(async (client) => {
      const now = this.now();
      const attemptResult = await client.query(
        `UPDATE public.storage_provider_attempts
            SET state = $4, retryable = $5,
                observed_checksum_sha256 = $6, observed_byte_length = $7,
                safe_diagnostic_category = $8, safe_diagnostic_code = $9,
                verified_at = CASE WHEN $4 = 'succeeded' THEN $10::timestamptz ELSE NULL END,
                finished_at = $10, updated_at = $10
          WHERE storage_provider_attempt_id = $1
            AND storage_object_copy_id = $2
            AND storage_object_id = $3
            AND state = 'in_progress'`,
        [
          input.reservation.providerAttemptId,
          input.reservation.storageObjectCopyId,
          input.reservation.storageObjectId,
          input.outcome.state === 'verified' ? 'succeeded' : 'failed',
          input.outcome.retryable,
          input.outcome.observedChecksumSha256 ?? null,
          input.outcome.observedByteLength ?? null,
          input.outcome.diagnostic?.category ?? null,
          input.outcome.diagnostic?.code ?? null,
          now,
        ],
      );
      if (attemptResult.rowCount !== 1) {
        throw new RuntimeStorageRegistryError(
          'duplicate-conflict',
          'targeted-retry-attempt-conflict',
          409,
        );
      }
      const copyResult = await client.query(
        `UPDATE public.storage_object_copies
            SET copy_state = $4,
                observed_checksum_sha256 = $5,
                observed_byte_length = $6,
                latest_verified_at = CASE WHEN $4 = 'verified' THEN $7 ELSE latest_verified_at END,
                updated_at = $7, row_version = row_version + 1
          WHERE storage_object_copy_id = $1
            AND storage_object_id = $2
            AND copy_state = 'pending'
            AND row_version = $3`,
        [
          input.reservation.storageObjectCopyId,
          input.reservation.storageObjectId,
          input.reservation.expectedPendingCopyVersion,
          input.outcome.state,
          input.outcome.observedChecksumSha256 ?? null,
          input.outcome.observedByteLength ?? null,
          now,
        ],
      );
      if (copyResult.rowCount !== 1) {
        throw new RuntimeStorageRegistryError(
          'duplicate-conflict',
          'targeted-retry-copy-conflict',
          409,
        );
      }
      const stateResult = await client.query<{
        provider_role: 'hot' | 'canonical';
        copy_state: 'verified' | 'failed';
      }>(
        `SELECT provider_role, copy_state
           FROM public.storage_object_copies
          WHERE storage_object_id = $1
            AND provider_role IN ('hot', 'canonical')
          ORDER BY provider_role`,
        [input.reservation.storageObjectId],
      );
      const states = new Map(stateResult.rows.map((row) => [row.provider_role, row.copy_state]));
      const hot = states.get('hot');
      const canonical = states.get('canonical');
      if (hot === undefined || canonical === undefined) {
        throw new RuntimeStorageRegistryError('internal', 'targeted-retry-copy-set-incomplete', 500);
      }
      const mapping = deriveStorageMapping({ hot, canonical });
      const objectResult = await client.query(
        `UPDATE public.storage_objects
            SET registry_state = $3, object_protection_stage = $4,
                activated_at = CASE WHEN $3 IN ('active', 'degraded')
                                    THEN COALESCE(activated_at, $5) ELSE activated_at END,
                updated_at = $5, row_version = row_version + 1
          WHERE storage_object_id = $1 AND row_version = $2`,
        [
          input.reservation.storageObjectId,
          input.reservation.expectedObjectRowVersion,
          mapping.registryState,
          mapping.objectProtectionStage,
          now,
        ],
      );
      if (objectResult.rowCount !== 1) {
        throw new RuntimeStorageRegistryError(
          'duplicate-conflict',
          'targeted-retry-object-conflict',
          409,
        );
      }
      return Object.freeze({
        storageObjectId: input.reservation.storageObjectId,
        storageState: mapping.storageState,
        objectProtectionStage: mapping.objectProtectionStage,
        copies: Object.freeze({
          hot: Object.freeze({ state: hot, retryable: hot === 'failed' }),
          canonical: Object.freeze({ state: canonical, retryable: canonical === 'failed' }),
        }),
      });
    });
  }

  async appendProviderAttempt(input: ProviderAttemptInput): Promise<string> {
    if (!Number.isSafeInteger(input.attemptNumber) || input.attemptNumber <= 0) {
      throw new RuntimeStorageRegistryError('invalid-request', 'invalid-attempt-number', 400);
    }
    const id = this.createId();
    await this.scope.run(async (client) => {
      const now = this.now();
      await client.query(
        `INSERT INTO public.storage_provider_attempts (
           storage_provider_attempt_id, storage_object_copy_id, storage_object_id, operation,
           operation_reference, attempt_number, state, retryable, next_retry_at,
           expected_checksum_sha256, expected_byte_length, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8, $9, $10, $11, $11)`,
        [
          id,
          input.storageObjectCopyId,
          input.storageObjectId,
          input.operation,
          input.operationReference,
          input.attemptNumber,
          input.retryable ?? false,
          input.nextRetryAt ?? null,
          input.expectedChecksumSha256 ?? null,
          input.expectedByteLength ?? null,
          now,
        ],
      );
    });
    return id;
  }

  async claimProviderAttempts(input: {
    owner: string;
    limit: number;
    leaseDurationMs: number;
  }): Promise<readonly ProviderAttemptRow[]> {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      throw new RuntimeStorageRegistryError('invalid-request', 'invalid-claim-limit', 400);
    }
    return this.scope.run(async (client) => {
      const now = this.now();
      const leaseExpiresAt = new Date(now.getTime() + input.leaseDurationMs);
      const leaseToken = this.createId();
      const result = await client.query<ProviderAttemptRow>(
        `WITH candidates AS (
           SELECT storage_provider_attempt_id
             FROM public.storage_provider_attempts
            WHERE (
                    state = 'pending' OR
                    (state = 'in_progress' AND lease_expires_at <= $1)
                  )
              AND (next_retry_at IS NULL OR next_retry_at <= $1)
              AND (lease_expires_at IS NULL OR lease_expires_at <= $1)
            ORDER BY COALESCE(next_retry_at, created_at), created_at
            FOR UPDATE SKIP LOCKED
            LIMIT $2
         )
         UPDATE public.storage_provider_attempts AS attempt
            SET state = 'in_progress', lease_owner = $3, lease_token = $5,
                lease_expires_at = $4, started_at = COALESCE(started_at, $1), updated_at = $1
           FROM candidates
          WHERE attempt.storage_provider_attempt_id = candidates.storage_provider_attempt_id
          RETURNING attempt.storage_provider_attempt_id, attempt.storage_object_copy_id,
                    attempt.storage_object_id, attempt.operation, attempt.operation_reference,
                    attempt.attempt_number, attempt.state, attempt.retryable,
                    attempt.next_retry_at, attempt.lease_owner, attempt.lease_token,
                    attempt.lease_expires_at, attempt.safe_diagnostic_category,
                    attempt.safe_diagnostic_code`,
        [now, input.limit, input.owner, leaseExpiresAt, leaseToken],
      );
      return Object.freeze(result.rows.map((row) => Object.freeze({ ...row })));
    });
  }

  async finishProviderAttempt(input: {
    providerAttemptId: string;
    leaseOwner: string;
    leaseToken: string;
    nextState: 'succeeded' | 'failed';
    retryable?: boolean;
    nextRetryAt?: Date;
    observedChecksumSha256?: string;
    observedByteLength?: number;
    verifiedAt?: Date;
    diagnostic?: Readonly<SafeDiagnostic>;
  }): Promise<void> {
    await this.scope.run(async (client) => {
      const result = await client.query(
        `UPDATE public.storage_provider_attempts
            SET state = $4, retryable = $5, next_retry_at = $6,
                observed_checksum_sha256 = $7, observed_byte_length = $8,
                verified_at = $9, safe_diagnostic_category = $10,
                safe_diagnostic_code = $11, finished_at = $12,
                lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
                updated_at = $12
          WHERE storage_provider_attempt_id = $1
            AND state = 'in_progress'
            AND lease_owner = $2
            AND lease_token = $3`,
        [
          input.providerAttemptId,
          input.leaseOwner,
          input.leaseToken,
          input.nextState,
          input.retryable ?? false,
          input.nextRetryAt ?? null,
          input.observedChecksumSha256 ?? null,
          input.observedByteLength ?? null,
          input.verifiedAt ?? null,
          input.diagnostic?.category ?? null,
          input.diagnostic?.code ?? null,
          this.now(),
        ],
      );
      if (result.rowCount !== 1) {
        throw new RuntimeStorageRegistryError('duplicate-conflict', 'provider-attempt-lease-conflict', 409);
      }
    });
  }

  async appendStorageEvent(input: SafeStorageEventInput): Promise<void> {
    assertSafeJsonObject(input.payload, 'event-payload');
    await this.scope.run(async (client) => {
      await client.query(
        `INSERT INTO public.storage_operation_events (
           storage_operation_event_id, dedupe_key, event_type, contract_version, occurred_at,
           managed_app_id, caller_service_id, storage_object_id, app_correlation_ref,
           safe_payload, safe_diagnostic_category, safe_diagnostic_code, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13)`,
        [
          input.eventId,
          input.dedupeKey,
          input.eventType,
          input.contractVersion,
          input.occurredAt,
          input.managedAppId,
          input.callerServiceId ?? null,
          input.storageObjectId ?? null,
          input.appCorrelationReference,
          JSON.stringify(input.payload),
          input.diagnostic?.category ?? null,
          input.diagnostic?.code ?? null,
          this.now(),
        ],
      );
    });
  }

  async openOrTouchReconciliationIssue(input: ReconciliationIssueInput): Promise<string> {
    const detail = input.safeDetail ?? {};
    assertSafeJsonObject(detail, 'reconciliation-detail');
    return this.scope.run(async (client) => {
      const now = this.now();
      const id = this.createId();
      const result = await client.query<{ storage_reconciliation_issue_id: string }>(
        `INSERT INTO public.storage_reconciliation_issues (
           storage_reconciliation_issue_id, storage_object_id, storage_object_copy_id,
           storage_provider_attempt_id, provider_role, category, summary_code, state,
           safe_detail, issue_fingerprint, first_detected_at, last_detected_at,
           next_retry_at, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'open', $8::jsonb, $9, $10, $10, $11, $10, $10)
         ON CONFLICT (issue_fingerprint) WHERE state IN ('open', 'acknowledged')
         DO UPDATE SET last_detected_at = EXCLUDED.last_detected_at,
                       next_retry_at = EXCLUDED.next_retry_at,
                       safe_detail = EXCLUDED.safe_detail,
                       updated_at = EXCLUDED.updated_at,
                       row_version = public.storage_reconciliation_issues.row_version + 1
         RETURNING storage_reconciliation_issue_id`,
        [
          id,
          input.storageObjectId ?? null,
          input.storageObjectCopyId ?? null,
          input.storageProviderAttemptId ?? null,
          input.providerRole ?? null,
          input.category,
          input.summaryCode,
          JSON.stringify(detail),
          input.issueFingerprint,
          now,
          input.nextRetryAt ?? null,
        ],
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw new RuntimeStorageRegistryError('internal', 'reconciliation-issue-write-failed', 500);
      }
      return row.storage_reconciliation_issue_id;
    });
  }

  async claimReconciliationIssues(input: {
    owner: string;
    limit: number;
    leaseDurationMs: number;
  }): Promise<readonly ReconciliationIssueRow[]> {
    return this.scope.run(async (client) => {
      const now = this.now();
      const claimToken = this.createId();
      const result = await client.query<ReconciliationIssueRow>(
        `WITH candidates AS (
           SELECT storage_reconciliation_issue_id
             FROM public.storage_reconciliation_issues
            WHERE state IN ('open', 'acknowledged')
              AND (next_retry_at IS NULL OR next_retry_at <= $1)
              AND (claim_expires_at IS NULL OR claim_expires_at <= $1)
            ORDER BY COALESCE(next_retry_at, first_detected_at), first_detected_at
            FOR UPDATE SKIP LOCKED
            LIMIT $2
         )
         UPDATE public.storage_reconciliation_issues AS issue
            SET claim_owner = $3, claim_token = $5,
                claim_expires_at = $4, updated_at = $1,
                row_version = row_version + 1
           FROM candidates
          WHERE issue.storage_reconciliation_issue_id = candidates.storage_reconciliation_issue_id
          RETURNING issue.storage_reconciliation_issue_id, issue.issue_fingerprint,
                    issue.state, issue.claim_owner, issue.claim_token,
                    issue.claim_expires_at, issue.row_version`,
        [
          now,
          input.limit,
          input.owner,
          new Date(now.getTime() + input.leaseDurationMs),
          claimToken,
        ],
      );
      return Object.freeze(result.rows.map((row) => Object.freeze({ ...row })));
    });
  }

  async resolveReconciliationIssue(input: {
    issueId: string;
    claimOwner: string;
    claimToken: string;
    expectedRowVersion: number;
  }): Promise<void> {
    await this.scope.run(async (client) => {
      const now = this.now();
      const result = await client.query(
        `UPDATE public.storage_reconciliation_issues
            SET state = 'resolved', resolved_at = $5, updated_at = $5,
                claim_owner = NULL, claim_token = NULL, claim_expires_at = NULL,
                row_version = row_version + 1
          WHERE storage_reconciliation_issue_id = $1
            AND claim_owner = $2 AND claim_token = $3
            AND row_version = $4 AND state IN ('open', 'acknowledged')`,
        [input.issueId, input.claimOwner, input.claimToken, input.expectedRowVersion, now],
      );
      if (result.rowCount !== 1) {
        throw new RuntimeStorageRegistryError('duplicate-conflict', 'reconciliation-issue-lease-conflict', 409);
      }
    });
  }
}
