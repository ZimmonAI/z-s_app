import type { SafeDiagnostic } from './runtime-contract.js';
import { PostgresRuntimeStorageRegistryObjectCore } from './runtime-storage-registry-object.js';
import {
  RuntimeStorageRegistryError,
  type DurableDuplicateResultCodec,
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
    async encode(value, _client) {
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

    async decode(reference, client) {
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
        }>(
          `SELECT intent.object_write_intent_id, intent.storage_object_id, intent.state,
                  object_record.expected_checksum_sha256,
                  object_record.expected_byte_length,
                  object_record.object_protection_stage
             FROM public.object_write_intents AS intent
             JOIN public.storage_objects AS object_record
               ON object_record.storage_object_id = intent.storage_object_id
            WHERE intent.object_write_intent_id = $1
              AND intent.storage_object_id = $2`,
          [writeIntentId, storageObjectId],
        );
        const row = result.rows[0];
        if (
          row === undefined ||
          row.state !== 'completed' ||
          row.object_protection_stage !== 'upload-completion-recorded'
        ) {
          throw new RuntimeStorageRegistryError('internal', 'idempotency-result-missing', 500);
        }
        return Object.freeze({
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
          objectProtectionStage: 'upload-completion-recorded' as const,
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

export class PostgresRuntimeStorageRegistry extends PostgresRuntimeStorageRegistryObjectCore {
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
