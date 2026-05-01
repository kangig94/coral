import type { Database } from '../../store/db.js';
import type { KbRuntime } from '../contract.js';

/**
 * Extract the writable journal handle from a `KbRuntime`.
 *
 * `KbRuntime` deliberately omits `db` from its contract (see
 * `tests/invariants/writable-db-coordinator-only.test.ts`) so non-KB callers
 * cannot reach through it for writes. KB-internal modules — primarily curate
 * state, retry queue, and discovery-backlog — still need direct access to the
 * underlying handle: this helper centralises the cast so the unsafe shape
 * lives in exactly one file. Do NOT import this outside `src/kb/`.
 */
export function curateDb(kb: KbRuntime): Database {
  return (kb as unknown as { readonly db: Database }).db;
}
