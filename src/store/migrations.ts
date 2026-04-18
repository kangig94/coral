import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type BetterSqlite3 from 'better-sqlite3';
import type { StoragePort } from '../runtime/ports.js';

declare const __PLUGIN_ROOT__: string | undefined;

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const SOURCE_MIGRATIONS_DIR = join(MODULE_DIR, 'migrations');
const BUNDLED_MIGRATIONS_DIR =
  typeof __PLUGIN_ROOT__ === 'string' ? join(__PLUGIN_ROOT__, 'dist', 'store', 'migrations') : undefined;

type MigrationStorage = Pick<StoragePort, 'readdirSync' | 'readFileSync'>;

export interface ApplyMigrationsOptions {
  readonly db: BetterSqlite3.Database;
  readonly storage: MigrationStorage;
  readonly migrationsDir?: string;
}

function readCurrentVersion(db: BetterSqlite3.Database): number {
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
    return row ? Number(row.value) : 0;
  } catch {
    return 0;
  }
}

function parseVersion(filename: string): number | null {
  const match = /^(\d+)_/.exec(filename);
  return match ? Number(match[1]) : null;
}

function defaultMigrationsDir(): string {
  return BUNDLED_MIGRATIONS_DIR ?? SOURCE_MIGRATIONS_DIR;
}

export function applyMigrations({ db, storage, migrationsDir = defaultMigrationsDir() }: ApplyMigrationsOptions): void {
  const currentVersion = readCurrentVersion(db);
  const files = storage
    .readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
    .map((entry) => ({ name: entry.name, version: parseVersion(entry.name) }))
    .filter((e): e is { name: string; version: number } => e.version !== null)
    .filter((e) => e.version > currentVersion)
    .sort((a, b) => a.version - b.version);

  if (files.length === 0) return;

  const applyTxn = db.transaction(() => {
    for (const entry of files) {
      const sql = storage.readFileSync(join(migrationsDir, entry.name), 'utf-8');
      db.exec(sql);
    }
  });
  applyTxn();
}
