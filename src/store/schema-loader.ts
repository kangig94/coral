import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';
import type { StoragePort } from '../runtime/ports.js';

declare const __PLUGIN_ROOT__: string | undefined;

function resolveModuleDir(): string {
  if (typeof __dirname === 'string') {
    return __dirname;
  }

  const previousPrepareStackTrace = Error.prepareStackTrace;
  try {
    Error.prepareStackTrace = (_error, stack) => stack;
    const stack = new Error().stack as unknown as Array<{ getFileName?: () => string | null }> | undefined;
    const fileName = stack
      ?.map((frame) => frame.getFileName?.() ?? null)
      .find((candidate) => typeof candidate === 'string' && /\/store\/schema-loader\.(?:ts|js)$/.test(candidate));

    if (typeof fileName === 'string') {
      return dirname(fileName);
    }
  } finally {
    Error.prepareStackTrace = previousPrepareStackTrace;
  }

  throw new Error('Cannot resolve schema-loader module directory: pass schemasDir explicitly.');
}

function defaultSchemasDirCandidates(): string[] {
  const moduleSchemasDir = join(resolveModuleDir(), 'schemas');
  if (typeof __PLUGIN_ROOT__ === 'string') {
    return [
      join(__PLUGIN_ROOT__, 'dist', 'store', 'schemas'),
      join(__PLUGIN_ROOT__, 'build', 'store', 'schemas'),
      moduleSchemasDir,
    ];
  }
  return [moduleSchemasDir];
}

const SEEDED_SCHEMAS_DIR = '/tmp/sim/store/schemas';

type SchemaStorage = Pick<StoragePort, 'readdirSync' | 'readFileSync'>;
type SchemaReadStorage = Pick<StoragePort, 'existsSync' | 'readdirSync' | 'readFileSync'>;
type SchemaWriteStorage = Pick<StoragePort, 'existsSync' | 'mkdirSync' | 'writeFileSync'>;
type SchemaSeedStorage = SchemaReadStorage & SchemaWriteStorage;

export interface ApplyStoreSchemasOptions {
  readonly db: BetterSqlite3.Database;
  readonly storage: SchemaStorage;
  readonly schemasDir?: string;
}

export const CURRENT_STORE_SCHEMA_VERSION = 1;

function readCurrentVersion(db: BetterSqlite3.Database): number {
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
      | { value: string }
      | undefined;
    return row ? Number(row.value) : 0;
  } catch {
    return 0;
  }
}

export function assertSupportedStoreSchema(db: BetterSqlite3.Database): void {
  const currentVersion = readCurrentVersion(db);
  if (currentVersion === CURRENT_STORE_SCHEMA_VERSION) {
    return;
  }

  throw new Error(
    `Store schema version ${currentVersion} is unsupported; expected ${CURRENT_STORE_SCHEMA_VERSION}. Reset local Coral store data and rebuild.`,
  );
}

function parseVersion(filename: string): number | null {
  const match = /^(\d+)_/.exec(filename);
  return match ? Number(match[1]) : null;
}

export function resolveDefaultSchemasDir(): string {
  const candidates = defaultSchemasDirCandidates();
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[candidates.length - 1];
}

export function copySchemaAssets(
  sourceStorage: SchemaReadStorage,
  targetStorage: SchemaWriteStorage,
  sourceDir: string,
  targetDir: string,
): boolean {
  if (!sourceStorage.existsSync(sourceDir)) {
    return false;
  }

  targetStorage.mkdirSync(targetDir, { recursive: true });
  for (const entry of sourceStorage.readdirSync(sourceDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.sql')) {
      continue;
    }

    const sourcePath = join(sourceDir, entry.name);
    const targetPath = join(targetDir, entry.name);
    if (targetStorage.existsSync(targetPath)) {
      continue;
    }

    targetStorage.writeFileSync(targetPath, sourceStorage.readFileSync(sourcePath, 'utf-8'));
  }

  return true;
}

export function ensureStoreSchemasDir(storage: SchemaSeedStorage, seededDir: string = SEEDED_SCHEMAS_DIR): string {
  const schemasDir = resolveDefaultSchemasDir();
  if (storage.existsSync(schemasDir)) {
    return schemasDir;
  }

  if (copySchemaAssets(storage, storage, schemasDir, seededDir)) {
    return seededDir;
  }

  return schemasDir;
}

export function applyStoreSchemas({
  db,
  storage,
  schemasDir = resolveDefaultSchemasDir(),
}: ApplyStoreSchemasOptions): void {
  const currentVersion = readCurrentVersion(db);
  const files = storage
    .readdirSync(schemasDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
    .map((entry) => ({ name: entry.name, version: parseVersion(entry.name) }))
    .filter((e): e is { name: string; version: number } => e.version !== null)
    .filter((e) => e.version > currentVersion)
    .sort((a, b) => a.version - b.version);

  if (files.length === 0) return;

  const applyTxn = db.transaction(() => {
    for (const entry of files) {
      const sql = storage.readFileSync(join(schemasDir, entry.name), 'utf-8');
      db.exec(sql);
    }
  });
  applyTxn.immediate();
}
