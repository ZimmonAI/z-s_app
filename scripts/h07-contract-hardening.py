from pathlib import Path


def replace(path: str, old: str, new: str, count: int | None = None) -> None:
    file = Path(path)
    text = file.read_text()
    occurrences = text.count(old)
    expected = 1 if count is None else count
    if occurrences != expected:
        raise SystemExit(f"{path}: expected {expected} occurrences, found {occurrences}: {old[:80]!r}")
    file.write_text(text.replace(old, new))


def replace_all(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    if old not in text:
        raise SystemExit(f"{path}: missing {old!r}")
    file.write_text(text.replace(old, new))

# PostgreSQL lifecycle mapping.
replace(
    "src/storage-service-postgres.ts",
    "import { StorageServiceError, completeCapabilities } from './storage-service.js';",
    "import {\n  StorageServiceError,\n  completeCapabilities,\n  storageServiceStatusForTest,\n} from './storage-service.js';",
)
replace("src/storage-service-postgres.ts", "  'awaiting-secret',", "  'setup_incomplete',")
replace("src/storage-service-postgres.ts", "    status = 'testing',", "    status = 'validating',")
replace(
    "src/storage-service-postgres.ts",
    "  ): Promise<Readonly<StorageServiceSnapshot>> {\n    const updated = await this.#queryable.query<StorageServiceRow>(`\nUPDATE public.storage_control_storage_services AS services\nSET status = CASE WHEN $4 THEN 'ready' ELSE 'failed' END,",
    "  ): Promise<Readonly<StorageServiceSnapshot>> {\n    const status = storageServiceStatusForTest(result.connected, result.diagnosticCode);\n    const updated = await this.#queryable.query<StorageServiceRow>(`\nUPDATE public.storage_control_storage_services AS services\nSET status = $9,",
)
replace(
    "src/storage-service-postgres.ts",
    "      result.diagnosticCode,\n      now,\n    ]);",
    "      result.diagnosticCode,\n      now,\n      status,\n    ]);",
)

# Additive migration lifecycle contract.
replace_all("db/migrations/0012_z_s_storage_services.sql", "'draft', 'awaiting-secret', 'testing', 'ready', 'failed', 'disabled', 'archived'", "'setup_incomplete', 'validating', 'ready', 'degraded', 'auth_failed', 'unreachable', 'misconfigured', 'disabled', 'archived'")
replace_all("db/migrations/0012_z_s_storage_services.sql", "status IN ('draft', 'awaiting-secret')", "status = 'setup_incomplete'")
replace_all("db/migrations/0012_z_s_storage_services.sql", "status IN ('testing', 'ready', 'failed', 'disabled', 'archived')", "status IN ('validating', 'ready', 'degraded', 'auth_failed', 'unreachable', 'misconfigured', 'disabled', 'archived')")

# Runtime credential scope is checked while resolving active configuration authority.
replace(
    "src/runtime-s3-provider.ts",
    "export interface ProviderCredentialResolver {\n  resolve(\n    secretReferenceId: string,\n  ): Promise<Readonly<ResolvedS3CredentialBinding>> | Readonly<ResolvedS3CredentialBinding>;\n}",
    "export interface ProviderCredentialScope {\n  readonly clientId: string;\n  readonly environment: 'dev' | 'staging' | 'prod';\n}\n\nexport interface ProviderCredentialResolver {\n  resolve(\n    secretReferenceId: string,\n    scope?: Readonly<ProviderCredentialScope>,\n  ): Promise<Readonly<ResolvedS3CredentialBinding>> | Readonly<ResolvedS3CredentialBinding>;\n}",
)
replace(
    "src/runtime-active-configuration.ts",
    "        await this.#credentialResolver.resolve(target.secretReferenceId);",
    "        await this.#credentialResolver.resolve(target.secretReferenceId, {\n          clientId: input.clientId,\n          environment: input.environment,\n        });",
)

# Product-facing system route. All server-rendered links and browser calls use one canonical path.
for path in [
    "src/storage-service-runtime.ts",
    "src/storage-service-presentation.ts",
    "src/storage-service-client.ts",
    "tests/storage-service-presentation.test.ts",
]:
    replace_all(path, "/client/storage/services", "/system/storage")
replace_all(
    "src/storage-service-presentation.ts",
    "['draft', 'awaiting-secret', 'testing', 'ready', 'failed', 'disabled', 'archived']",
    "['setup_incomplete', 'validating', 'ready', 'degraded', 'auth_failed', 'unreachable', 'misconfigured', 'disabled', 'archived']",
)

# Tests and migration fixtures use the accepted lifecycle names.
for path in [
    "tests/storage-service-migration.test.ts",
    "tests/storage-service-presentation.test.ts",
]:
    text = Path(path).read_text()
    text = text.replace("awaiting-secret", "setup_incomplete")
    text = text.replace("testing", "validating")
    Path(path).write_text(text)

# Cross-client runtime resolution must fail safely.
test_path = Path("tests/storage-service.test.ts")
test_text = test_path.read_text()
if "cross-client storage service reference resolution is rejected" not in test_text:
    test_text = test_text.replace(
        "import { StorageServiceApplicationService } from '../src/storage-service-application.js';",
        "import { StorageServiceApplicationService } from '../src/storage-service-application.js';\nimport { StorageServiceProviderCredentialResolver, storageServiceSecretReference } from '../src/storage-service-credential-resolver.js';",
    )
    test_text += r'''

test('cross-client storage service reference resolution is rejected', async () => {
  const { service, repository } = fixture();
  const stored = await service.createClientOwned('client-a', createInput);
  const resolver = new StorageServiceProviderCredentialResolver({
    services: repository,
    secrets: {
      configured: true,
      store: async () => { throw new Error('not-used'); },
      resolve: async () => { throw new Error('not-used'); },
      revoke: async () => undefined,
    },
    adapters: new StorageProviderAdapterRegistry([]),
    managedResolver: {
      resolve: () => { throw new Error('not-used'); },
    },
  });
  await assert.rejects(
    resolver.resolve(storageServiceSecretReference(stored.id), {
      clientId: 'client-b',
      environment: 'dev',
    }),
    (error: unknown) => error instanceof StorageServiceError &&
      error.code === 'storage-service-reference-scope-mismatch',
  );
});
'''
    test_path.write_text(test_text)

# Exact H07 planning handback artifacts.
result = Path("08-execution/z-s_app-mvp/tasks/planning/t2-client-storage-workspace/handoffs/07-online-storage-service-management-r2-result.md")
result.parent.mkdir(parents=True, exist_ok=True)
result.write_text("""# H07 Online Storage Service Management and Cloudflare R2 Result\n\n## Source baseline\n\nImplemented from frozen Z-s source commit `3893514679003ea464958c1865624dcdb66cdd92`. No production deployment or provider credential handback was performed.\n\n## Delivered\n\n- Product-facing storage service management at `/system/storage`, with environment, provider, ownership, and lifecycle filters.\n- Provider-neutral service lifecycle using `setup_incomplete`, `validating`, `ready`, `degraded`, `auth_failed`, `unreachable`, `misconfigured`, `disabled`, and `archived`.\n- Cloudflare R2 client-owned setup with AES-256-GCM server-side envelopes bound to client, environment, service, and provider context.\n- Bounded write, head verification, and cleanup connection tests without bucket listing or unrelated deletion.\n- Safe storage-service references for configuration adoption while preserving deployment-managed credential references.\n- Dependency-aware disable/archive behavior, safe activity history, regression coverage, additive migration, and rollback.\n- Active configuration credential resolution validates client/environment scope before accepting a storage-service reference.\n\n## H08 live handback procedure\n\n1. Select a non-production client and environment.\n2. Provision a dedicated R2 bucket and least-privilege key limited to object write/read/head/delete in the agreed probe prefix.\n3. Open `/system/storage`, create the R2 service, and submit credentials through the write-only setup form.\n4. Confirm the browser response contains no credential, ciphertext, nonce, authentication tag, key version, endpoint, bucket, or secret-reference value.\n5. Run the bounded connection test and retain only the safe diagnostic/result timestamp.\n6. Confirm the probe object is removed from the exact generated key and no listing operation occurred.\n7. Create a configuration draft from the ready service and validate it.\n8. Activate the configuration through the existing control flow.\n9. Perform one bounded object write, head/read verification, and cleanup or retention action through the normal runtime.\n10. Confirm the runtime used the intended client/environment service and that a mismatched client scope is rejected.\n11. Exercise credential replacement and retest; confirm the previous envelope is revoked.\n12. Exercise an invalid credential and unreachable endpoint scenario and confirm `auth_failed` and `unreachable` safe states.\n13. Confirm active dependencies block disable/archive.\n14. Remove test dependencies, disable and archive the test service, then verify it cannot be selected for new configuration.\n15. Retain only non-secret logs, timestamps, IDs, checksums, status codes, and screenshots with private values redacted.\n16. Record H08 acceptance or rollback decision; do not commit provider credentials to GitHub.\n\n## Deferred\n\nReal provider credentials and live R2 execution are explicitly deferred to H08. Production deployment remains out of scope.\n""")
index = Path("08-execution/z-s_app-mvp/tasks/planning/t2-client-storage-workspace/evidence-indexes/07-online-storage-service-management-r2-evidence-index.md")
index.parent.mkdir(parents=True, exist_ok=True)
index.write_text("""# H07 Online Storage Service Management and R2 Evidence Index\n\n- Source result and H08 procedure: `../handoffs/07-online-storage-service-management-r2-result.md`\n- Product documentation: `docs/storage-services.md`\n- Migration: `db/migrations/0012_z_s_storage_services.sql`\n- Rollback: `db/migrations/0012_z_s_storage_services.down.sql`\n- Migration validator: `scripts/validate-storage-service-migration.mjs`\n- Source validation evidence: `evidence/t2-h07-storage-services/01-source-validation.json`\n- Security contract evidence: `evidence/t2-h07-storage-services/02-security-contract.json`\n- Existing detailed H08 procedure: `evidence/t2-h07-storage-services/03-h08-execution-procedure.md`\n- Focused tests: `tests/storage-service.test.ts`, `tests/storage-service-migration.test.ts`, `tests/storage-service-presentation.test.ts`, `tests/cloudflare-r2-adapter.test.ts`, `tests/provider-secret-store.test.ts`\n\nNo provider secret, encryption key, ciphertext envelope, private endpoint, bucket name, or object key is evidence-safe for repository retention.\n""")
