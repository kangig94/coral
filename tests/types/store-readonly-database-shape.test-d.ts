/**
 * The compile-time guarantee that `ReadonlyDatabase`/`ReadonlyStatement` (`src/store/read-port.ts`) expose no
 * write surface, kept where `tsc -p tsconfig/typecheck.json` (via `npm run typecheck:tests`) runs it in CI
 * rather than only in a mutation somebody performed once and reverted.
 *
 * `KbReadPort` and its wrapper module `src/kb/read-port.ts` are gone — `src/kb/runtime-contract.ts` and
 * `src/kb/queries.ts` now import `ReadonlyDatabase` directly — but the guarantee these types existed to hold
 * still matters: nothing about `ReadonlyDatabase` as declared today stops a future edit from adding `exec`
 * (or another write/native-code primitive) back onto it, and vitest does not typecheck, so only this file
 * would ever notice.
 */

import type { Database } from '#src/store/db.js';
import type { ReadonlyDatabase } from '#src/store/read-port.js';

declare const db: ReadonlyDatabase;

// `ReadonlyDatabase` declares only `prepare`/`close`, so it must not satisfy the writable `Database`
// contract — filling a `Database`-typed slot with one would let a read handle reach every write method below
// through the wider type instead of this one.
// @ts-expect-error ReadonlyDatabase is not assignable to the writable Database.
const _writableAlias: Database = db;
void _writableAlias;

// Each of these is a write or native-code-loading primitive `node:sqlite`'s `DatabaseSync` carries. None
// belongs on a type whose whole purpose is making a write unreachable from the read side.
// @ts-expect-error ReadonlyDatabase has no `exec` method.
db.exec('CREATE TABLE forbidden_write(id TEXT)');
// @ts-expect-error ReadonlyDatabase has no `function` method.
db.function('forbidden_fn', () => 0);
// @ts-expect-error ReadonlyDatabase has no `aggregate` method.
db.aggregate('forbidden_agg', { start: 0, step: () => 0 });
// @ts-expect-error ReadonlyDatabase has no `loadExtension` method.
db.loadExtension('/tmp/nope');
// @ts-expect-error ReadonlyDatabase has no `enableLoadExtension` method.
db.enableLoadExtension(true);
// @ts-expect-error ReadonlyDatabase has no `applyChangeset` method.
db.applyChangeset(new Uint8Array());

// `run` is intentionally absent from `ReadonlyStatement`, so a write is unreachable even once a caller
// already holds a prepared statement obtained through the read-only handle above.
const _stmt = db.prepare<[string], { value: string }>('UPDATE forbidden SET x = ?');
// @ts-expect-error ReadonlyStatement has no `run` method.
_stmt.run('value');

// Sanity: the legitimate read surface still resolves without error, so the rejections above are the type
// system refusing a real write primitive — not `ReadonlyDatabase` being unusable in every direction.
const _row = _stmt.get('value');
const _rows = _stmt.all('value');
const _iterator = _stmt.iterate('value');
void _row;
void _rows;
void _iterator;
db.close();
