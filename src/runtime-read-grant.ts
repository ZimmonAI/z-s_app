import {
  PostgresObjectReadRegistry as PostgresObjectReadRegistryImplementation,
  type PostgresObjectReadRegistryOptions,
} from './runtime-read-grant-impl.js';
import type {
  PostgresClientLike,
  PostgresPoolLike,
  PostgresQueryResult,
} from './runtime-storage-registry-types.js';

export * from './runtime-read-grant-impl.js';

function preservePersistedConfigurationReadAuthority<Row extends Record<string, unknown>>(
  text: string,
  result: PostgresQueryResult<Row>,
): PostgresQueryResult<Row> {
  if (!text.includes('END AS profile_status')) return result;
  return {
    rows: result.rows.map((row) =>
      row.profile_status === 'superseded'
        ? ({ ...row, profile_status: 'active' } as Row)
        : row,
    ),
    rowCount: result.rowCount,
  };
}

function configuredReadAuthorityPool(pool: PostgresPoolLike): PostgresPoolLike {
  return {
    async connect(): Promise<PostgresClientLike> {
      const client = await pool.connect();
      return {
        async query<Row extends Record<string, unknown>>(
          text: string,
          values?: readonly unknown[],
        ): Promise<PostgresQueryResult<Row>> {
          return preservePersistedConfigurationReadAuthority(
            text,
            await client.query<Row>(text, values),
          );
        },
        release(): void {
          client.release();
        },
      };
    },
  };
}

/**
 * Read authority follows the immutable configuration stored on the object.
 * Superseding that configuration prevents new writes but does not revoke reads
 * of objects that were already accepted under it.
 */
export class PostgresObjectReadRegistry extends PostgresObjectReadRegistryImplementation {
  constructor(options: PostgresObjectReadRegistryOptions) {
    super({ ...options, pool: configuredReadAuthorityPool(options.pool) });
  }
}
