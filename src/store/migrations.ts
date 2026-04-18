import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type BetterSqlite3 from 'better-sqlite3';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(MODULE_DIR, 'migrations');

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

export function applyMigrations(db: BetterSqlite3.Database): void {
  const currentVersion = readCurrentVersion(db);
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .map((f) => ({ name: f, version: parseVersion(f) }))
    .filter((e): e is { name: string; version: number } => e.version !== null)
    .filter((e) => e.version > currentVersion)
    .sort((a, b) => a.version - b.version);

  if (files.length === 0) return;

  const applyTxn = db.transaction(() => {
    for (const entry of files) {
      const sql = readFileSync(join(MIGRATIONS_DIR, entry.name), 'utf8');
      db.exec(sql);
    }
  });
  applyTxn();
}
