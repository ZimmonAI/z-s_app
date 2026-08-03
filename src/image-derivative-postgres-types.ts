import type { PostgresPoolLike, PostgresQueryable } from './runtime-storage-registry-types.js';

export interface PostgresImageDerivativeContext {
  readonly pool: PostgresPoolLike;
  readonly queryable: PostgresQueryable;
  readonly now: () => Date;
  readonly createId: () => string;
  readonly createLeaseToken: () => string;
}
