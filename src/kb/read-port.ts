import type BetterSqlite3 from 'better-sqlite3';
import { dirname } from 'node:path';

import type { Runtime } from '../runtime/ports.js';
import { openStoreDatabase } from '../store/db.js';

export interface ReadonlyStatement<BindParameters extends unknown[] = unknown[], Result = unknown> {
  readonly source: string;
  readonly reader: boolean;
  readonly readonly: boolean;
  readonly busy: boolean;
  get(...params: BindParameters): Result | undefined;
  all(...params: BindParameters): Result[];
  iterate(...params: BindParameters): IterableIterator<Result>;
  pluck(toggleState?: boolean): ReadonlyStatement<BindParameters, Result>;
  expand(toggleState?: boolean): ReadonlyStatement<BindParameters, Result>;
  raw(toggleState?: boolean): ReadonlyStatement<BindParameters, Result>;
  columns(): BetterSqlite3.ColumnDefinition[];
  safeIntegers(toggleState?: boolean): ReadonlyStatement<BindParameters, Result>;
}

export interface ReadonlyDatabase {
  readonly memory: boolean;
  readonly readonly: boolean;
  readonly name: string;
  readonly open: boolean;
  readonly inTransaction: boolean;
  // Matches better-sqlite3's named-parameter generic so Database remains structurally compatible.
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  prepare<BindParameters extends unknown[] | {} = unknown[], Result = unknown>(
    source: string,
  ): BindParameters extends unknown[]
    ? ReadonlyStatement<BindParameters, Result>
    : ReadonlyStatement<[BindParameters], Result>;
  close(): void;
}

export interface KbReadPort {
  readonly db: ReadonlyDatabase;
}

type OpenReadOnlyStoreOptions = {
  readonly path?: string;
  readonly busyTimeoutMs?: number;
};

export function asReadonlyDatabase(db: BetterSqlite3.Database): ReadonlyDatabase {
  return db;
}

export function openReadOnlyStoreDatabase(
  runtime: Pick<Runtime, 'paths' | 'storage'>,
  options: OpenReadOnlyStoreOptions = {},
): ReadonlyDatabase {
  const path = options.path ?? runtime.paths.coral.store.dbFile;
  if (path !== ':memory:') {
    runtime.storage.mkdirSync(dirname(path), { recursive: true });
  }

  return openStoreDatabase({
    path: path,
    storage: runtime.storage,
    readonly: true,
    busyTimeoutMs: options.busyTimeoutMs,
  });
}
