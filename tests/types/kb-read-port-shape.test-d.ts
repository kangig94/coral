/**
 * Type-level half of `tests/invariants/kb-read-port-shape.test.ts`.
 *
 * The runtime invariant walks the import graph and AST of `src/kb/read-port.ts`
 * to ensure no rebuild/persist symbols leak. This file binds the *structural*
 * claim: `KbReadPort.db` is a constrained `ReadonlyDatabase`, not assignable
 * to a writable `BetterSqlite3.Database`, and exposes no arbitrary-SQL surface.
 *
 * Typechecked by `tsc -p tests/types/tsconfig.json` (run from `npm test`).
 * Vitest does not typecheck, so `@ts-expect-error` directives outside this
 * directory are dead text — keep type-level assertions here.
 */

import type BetterSqlite3 from 'better-sqlite3';

import type { KbReadPort } from '#src/kb/read-port.js';
import type { ReadonlyDatabase } from '#src/store/read-port.js';

declare const _readPort: KbReadPort;

// `readPort.db` is a `ReadonlyDatabase`, not a writable better-sqlite3 Database.
// Assigning it to `BetterSqlite3.Database` must be a type error.
// @ts-expect-error KbReadPort.db is ReadonlyDatabase, not the full writable Database.
const _writableAlias: BetterSqlite3.Database = _readPort.db;
void _writableAlias;

// `ReadonlyDatabase` exposes no arbitrary-SQL surface (no `exec`, `pragma`,
// `transaction`, `function`, `aggregate`, `loadExtension`, `defaultSafeIntegers`,
// `serialize`, `backup`). Each must fail to resolve at the type level.
// @ts-expect-error ReadonlyDatabase has no `exec` method.
_readPort.db.exec('CREATE TABLE forbidden_write(id TEXT)');
// @ts-expect-error ReadonlyDatabase has no `pragma` method.
_readPort.db.pragma('journal_mode = WAL');
// @ts-expect-error ReadonlyDatabase has no `transaction` method.
_readPort.db.transaction(() => undefined);
// @ts-expect-error ReadonlyDatabase has no `function` method.
_readPort.db.function('forbidden_fn', () => undefined);
// @ts-expect-error ReadonlyDatabase has no `aggregate` method.
_readPort.db.aggregate('forbidden_agg', { start: 0, step: () => 0 });
// @ts-expect-error ReadonlyDatabase has no `loadExtension` method.
_readPort.db.loadExtension('/tmp/nope');
// @ts-expect-error ReadonlyDatabase has no `defaultSafeIntegers` method.
_readPort.db.defaultSafeIntegers(true);
// @ts-expect-error ReadonlyDatabase has no `serialize` method.
_readPort.db.serialize();
// @ts-expect-error ReadonlyDatabase has no `backup` method.
_readPort.db.backup('/tmp/nope.db');

// `prepare(...).run` is intentionally NOT exposed by `ReadonlyStatement`,
// so write statements are unreachable through the read port.
const _stmt = _readPort.db.prepare<unknown[], unknown>('UPDATE forbidden SET x = ?');
// @ts-expect-error ReadonlyStatement has no `run` method.
_stmt.run('value');

// Sanity: a value typed as `ReadonlyDatabase` is assignable into the port.
declare const _ro: ReadonlyDatabase;
const _wired: KbReadPort = { db: _ro };
void _wired;
