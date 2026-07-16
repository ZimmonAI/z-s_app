# 2B-03 coding handoff: installable contract and runtime service foundation

## Authority and correction context

This handoff implements 2B-03 in the canonical Z-s source repository. A prior implementation was mistakenly placed in `ZimmonAI/z-acc-state_app`; that repository is being restored separately. No account-state source is an authority for this implementation.

## Exact source baseline

```yaml
repository: https://github.com/ZimmonAI/z-s_app
branch: main
baseline_commit: 9d045c7efed1fd337f9c475dc6a8d3beee69912b
implementation_branch: agent/02b-03-runtime-contract-foundation
existing_package: '@zimspace/z-s-control-plane@0.1.0'
target_package: '@zimspace/z-s-control-plane@0.2.0'
service_id: z-s
contract_version: '1.0'
node_runtime: '>=22'
```

The existing package is extended rather than creating a second workspace package. Consumers receive explicit root and subpath exports from one exact private package identity.

## Allowed files

Only these paths may change in this coding handoff:

- `.github/workflows/2b-03-runtime-contract-validation.yml`
- `docs/02b-03-package-installable-contract-and-runtime-service-foundation.md`
- `docs/runtime-contract.md`
- `package.json`
- `src/index.ts`
- `src/runtime-contract.ts`
- `src/runtime-service.ts`
- `tests/runtime-service.test.ts`
- `scripts/install-smoke.mjs`

No migrations, seeds, provider adapters, environment files, deployment files, browser code, Video Maker source, Z-X source, database schema, or provider configuration may change.

The validation workflow is limited to checkout, Node setup, dependency installation and `npm run validate`. It performs no service startup, database connection, provider call, deployment or browser action.

## Selected transport

The first transport is authenticated server-to-server HTTP JSON implemented against the standard Node.js `Request` and `Response` APIs.

Reasons:

- it is directly usable from server routes and services;
- it creates no framework or provider SDK dependency;
- it is testable without network listeners;
- it supports explicit authentication, caller identity, contract versioning, correlation and duplicate protection;
- the same semantic contract remains transport-neutral for later adapters.

Rejected for the first transport:

- direct database access by consumers: violates Z-s ownership;
- provider SDKs in consumers: exposes provider authority;
- browser-first transport: browser upload is downstream work;
- gRPC: unnecessary operational and code-generation scope for the first bounded foundation;
- queue-only commands: unsuitable for health/readiness and immediate authorization responses.

## Required implementation

- exact package, service and contract identity;
- explicit installable package exports;
- confirmed Z-s contract families;
- existing `ProviderCapabilityPolicy` and `IntegrityVerificationResult` in the public package surface;
- authenticated caller boundary;
- contract-version rejection;
- typed write-intent validation;
- safe structured diagnostics;
- request correlation;
- injectable duplicate-protection persistence boundary;
- bounded profile resolution;
- separate process health and control-plane/data-plane readiness;
- injectable operation and readiness dependencies;
- no provider endpoints, credentials, secret references or object keys in normal results;
- no Video Maker or Z-X business logic.

## Required validation

```bash
npm run test:focused
npm test
npm run typecheck
npm run lint
npm run build
npm run pack:check
npm run validate:migration
npm run validate:seed
npm run validate:secrets
npm run validate:legacy-id
npm run local:readiness
npm run validate
```

Acceptance coverage must include:

- exact exported runtime surface;
- incompatible contract rejection;
- invalid caller rejection;
- safe-diagnostic serialization;
- endpoint, secret-reference, credential and object-key leakage checks;
- duplicate replay and conflicting-key rejection;
- synchronous and asynchronous readiness failure containment;
- health versus readiness distinction;
- clean-consumer installation from an exact generated package tarball;
- no floating Git branch or permanent local-file dependency.

## Rollback

Before merge, close the pull request and delete the implementation branch. After merge, revert the merge commit. The change creates no live schema, provider object, secret, deployment or environment state, so no external rollback is required.

## Report path and handback

This page is the source coding report. Completion must record the final merge revision, exact package version, generated tarball identity/checksum from validation, test results, consumer examples, official-document impact and explicit 2B-04 unblock status in the canonical execution authorities.
