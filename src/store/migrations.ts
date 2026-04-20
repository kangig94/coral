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
      .find((candidate) => typeof candidate === 'string' && /\/store\/migrations\.(?:ts|js)$/.test(candidate));

    if (typeof fileName === 'string') {
      return dirname(fileName);
    }
  } finally {
    Error.prepareStackTrace = previousPrepareStackTrace;
  }

  return join(process.env.CLAUDE_PLUGIN_ROOT ?? process.env.INIT_CWD ?? process.cwd(), 'src', 'store');
}

const SOURCE_MIGRATIONS_DIR = join(resolveModuleDir(), 'migrations');
const BUNDLED_MIGRATIONS_DIR =
  typeof __PLUGIN_ROOT__ === 'string' ? join(__PLUGIN_ROOT__, 'dist', 'store', 'migrations') : undefined;
const SEEDED_MIGRATIONS_DIR = '/tmp/sim/store/migrations';

type MigrationStorage = Pick<StoragePort, 'readdirSync' | 'readFileSync'>;
type MigrationReadStorage = Pick<StoragePort, 'existsSync' | 'readdirSync' | 'readFileSync'>;
type MigrationWriteStorage = Pick<StoragePort, 'existsSync' | 'mkdirSync' | 'writeFileSync'>;
type MigrationSeedStorage = MigrationReadStorage & MigrationWriteStorage;

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

export function resolveDefaultMigrationsDir(): string {
  return BUNDLED_MIGRATIONS_DIR ?? SOURCE_MIGRATIONS_DIR;
}

export function copyMigrationAssets(
  sourceStorage: MigrationReadStorage,
  targetStorage: MigrationWriteStorage,
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

export function ensureStoreMigrationsDir(
  storage: MigrationSeedStorage,
  seededDir: string = SEEDED_MIGRATIONS_DIR,
): string {
  const migrationsDir = resolveDefaultMigrationsDir();
  if (storage.existsSync(migrationsDir)) {
    return migrationsDir;
  }

  if (copyMigrationAssets(storage, storage, migrationsDir, seededDir)) {
    return seededDir;
  }

  return migrationsDir;
}

export function applyMigrations({ db, storage, migrationsDir = resolveDefaultMigrationsDir() }: ApplyMigrationsOptions): void {
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
  applyTxn.immediate();
}
