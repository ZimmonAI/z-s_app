# T2 H05 operations and validation report

## Local isolated validation

The new TypeScript modules were compiled under the repository's strict compiler settings using local type stubs for unchanged repository interfaces. Seven isolated unit/runtime tests passed:

- bounded PNG verify/resize/encode;
- unsupported output format rejection;
- completion only after verified output persistence;
- same-client status authorization;
- integration bearer token rejection;
- additive unavailable workspace state;
- upload response preservation with idempotent enqueue.

The PostgreSQL integration test is included for CI's ephemeral PostgreSQL 17 service. No shared or approval database was contacted.

## Operational controls

- worker concurrency: 2;
- maximum attempts: 3;
- retry delay: 60 seconds;
- lease duration: 5 minutes;
- source maximum: 32 MiB;
- decoded maximum: 64 million pixels;
- output maximum: 16 MiB;
- status maximum: 50 rows;
- browser output: safe metadata only.

## Rollback

Rollback restores the H03 copy guard and authority constraint only when all derivative tables and adopted output references are empty. Any adopted data blocks rollback.

## Pending proof

H04B remains pending because the external approval database is not reachable from this implementation environment. This report is not deployment or readiness evidence.
