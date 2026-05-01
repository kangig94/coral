import type { ReadonlyDatabase } from '../store/read-port.js';

/**
 * KB read port — wraps a generic store-level `ReadonlyDatabase`
 * (`store/read-port.ts`) with KB-domain identity so direct KB read paths
 * (`kb/queries.ts` and the host composer at
 * `read-model/kb-query-runtime.ts`) consume a typed KB surface rather
 * than a bare database. The store-level primitives stay generic and are
 * not redeclared here; consumers that just need a read-only database
 * import directly from `store/read-port.ts`.
 */
export interface KbReadPort {
  readonly db: ReadonlyDatabase;
}
