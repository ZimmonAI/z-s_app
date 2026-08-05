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
