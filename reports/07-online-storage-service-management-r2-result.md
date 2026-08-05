# T2 H07 online storage service management — source result

## Result

Source implementation is complete on `agent/t2-client-storage-service-management-r2`, based on exact main revision `3893514679003ea464958c1865624dcdb66cdd92`, and is published in draft pull request #32.

No live database migration, real provider credential, remote Cloudflare R2 operation, deployment, production approval, or deployed browser verification was performed in this source-only handoff.

## Implemented

- Provider-neutral storage-service lifecycle including draft, secret onboarding, bounded testing, ready, failure, disabled, archived, dependency-blocked, and awaiting-adapter behavior.
- Explicit `z-s-managed` and `client-owned` ownership with separate credential authorities.
- AES-256-GCM provider-secret storage with random per-record nonce, key version, and client/environment/service/provider associated data.
- Ciphertext-only PostgreSQL persistence with replacement and revocation; no reveal contract.
- Cloudflare R2 adapter manifest, setup workflow, runtime binding, capability declaration, bounded write/head/delete connection test, cleanup, and safe error classification.
- Client-scoped dashboard, onboarding, detail, setup, workflow, activity, usage/dependency visibility, and safe lifecycle actions.
- Safe configuration facade that removes internal secret references from browser and public API results.
- Ready-service configuration draft creation and activation-time readiness/capability enforcement.
- Unified credential resolver used by image derivatives and the main ingest/read runtime composition, while preserving the existing deployment-managed binding path.
- Scoped credential-resolution contract for client/environment isolation.
- Additive migration `0012_z_s_storage_services` and guarded rollback.
- Exact H08 live-verification procedure under `evidence/t2-h07-storage-services/03-h08-execution-procedure.md`.

## Verified source checks

GitHub Actions run `30994116624` proved the complete source validation chain through evidence upload:

- clean dependency installation;
- focused storage-service and resolver tests;
- migration `0012` contract validation;
- the complete non-database and PostgreSQL integration suites;
- strict TypeScript compilation and typecheck;
- lint, build, package smoke, and package artifact verification;
- migration, seed, secret, and legacy-identifier validation;
- local readiness and non-secret evidence retention.

The run’s final publication step failed only because the GitHub Actions token lacked workflow-file write permission. The same validated workflow, package, report, and evidence edits were committed directly through the repository connector.

## H08 boundary

H08 must still apply/rehearse the live migration, use authorized real R2 credentials within a task-owned prefix, verify browser accessibility and deployed routes, prove live configuration linking and runtime delivery, clean provider test objects and task rows, and record the deployed revision. Production approval remains outside H07.

## Exact H08 execution procedure

# H08 deployment and live verification procedure

1. Review and merge the H07 source PR only after required CI checks pass.
2. Generate a 32-byte production master key in the approved deployment secret manager. Bind it as `Z_S_PROVIDER_SECRET_MASTER_KEY_V1`; do not place it in repository files, command history, tickets, screenshots, or evidence.
3. Back up the target PostgreSQL database and record only the approved backup evidence reference.
4. Apply migrations through `0012_z_s_storage_services.sql` in staging. Verify the migration transaction commits and that the new service, provider-secret, activity, trigger, indexes, and provider-connection column exist.
5. Deploy the staging application with the master-key binding and existing session/PostgreSQL bindings.
6. Sign in through the normal client browser flow. Verify `/client/storage/services` renders and that another client cannot enumerate or open the test client’s service IDs.
7. Create a client-owned Cloudflare R2 service using a dedicated staging-only credential restricted to one staging test bucket/prefix. Do not capture the credential in evidence.
8. Verify the browser never redisplays the credential after submission. Inspect network responses and confirm they contain no credential, ciphertext, provider endpoint, private bucket, object key, signed URL, or internal secret reference.
9. Verify the bounded connection test creates only one probe object under the approved prefix, performs head verification, and removes the probe. Confirm no list-account, list-bucket, or broader prefix operation occurs.
10. Verify `ready` appears only after the test passes. Simulate an invalid credential replacement and verify the service becomes `failed` with a safe diagnostic and no provider-private text.
11. Replace with a valid credential. Verify the prior encrypted envelope is revoked and the service returns to `ready`.
12. Create a configuration draft from the ready service. Configure one vault and route, then verify activation succeeds only while the service remains ready and required capabilities are true.
13. Force a safe capability mismatch or failed service state in staging. Verify activation is blocked with the expected safe code and that the prior active configuration remains unchanged.
14. Restore readiness. Upload, read, range-read, and delete a generated non-sensitive object through the accepted runtime path. Verify provider routing uses the client-owned service binding.
15. Verify dependency counts show draft/active configuration, vault, route, object-copy, and derivative-output usage without private locators.
16. Verify disable is blocked while an active configuration depends on the service. Verify archive is blocked while durable copies or derivative outputs remain.
17. Verify activity shows safe lifecycle events and excludes credential/private provider values.
18. Run the full repository validation chain, migration validators, package checks, readiness checks, and deployed browser accessibility smoke.
19. Repeat the approved migration/deployment sequence in production using production-only credentials and a production-approved bounded test prefix.
20. Record only safe deployment IDs, commit SHA, migration result, test timestamps, status codes, safe diagnostics, and redacted screenshots in the H08 evidence pack.
