import { execSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

export function exitIfChildProcess() {
  if (process.env.CORAL_CHILD === '1') process.exit(0);
}

export function parseManifestFlavor(manifestPath) {
  try {
    return JSON.parse(readFileSync(manifestPath, 'utf8')).flavor === 'dev' ? 'dev' : 'prod';
  } catch {
    return null;
  }
}

let _cachedFlavor;
let _cachedFlavorSource;

function readBuildFlavorState() {
  if (_cachedFlavor !== undefined && _cachedFlavorSource !== undefined) {
    return { flavor: _cachedFlavor, source: _cachedFlavorSource };
  }

  const here = fileURLToPath(import.meta.url);
  const manifest = resolve(dirname(here), '..', '..', 'bridge', 'manifest.json');
  const parsed = parseManifestFlavor(manifest);
  _cachedFlavor = parsed ?? 'prod';
  _cachedFlavorSource = parsed === null ? 'fallback' : 'manifest';
  return { flavor: _cachedFlavor, source: _cachedFlavorSource };
}

export function buildFlavor() {
  return readBuildFlavorState().flavor;
}

export function exitIfWrongFlavor() {
  const want = process.env.CORAL_FLAVOR;
  if (want !== undefined && want !== 'prod' && want !== 'dev') {
    process.stderr.write(`[coral] CORAL_FLAVOR='${want}' is not recognized (expected 'prod' or 'dev')\n`);
    process.exit(1);
  }
  const actual = readBuildFlavorState();
  if (actual.flavor !== (want ?? 'prod')) {
    if (want === 'dev' && actual.flavor === 'prod' && actual.source === 'fallback') {
      process.stderr.write(
        '[coral] CORAL_FLAVOR=dev requested, but bridge/manifest.json is missing or unreadable; falling back to prod flavor gating\n',
      );
    }
    process.exit(0);
  }
}

export function readStdin() {
  return new Promise(resolve => {
    let data = '';
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve('{}'));
  });
}

export function logHookLine(hookName, message, extra = {}) {
  process.stderr.write(`${JSON.stringify({ hook: hookName, message, ...extra })}\n`);
}

export async function failOpen(work, hookName = 'hook') {
  try {
    await work();
  } catch (error) {
    logHookLine(hookName, 'fail-open', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function readUserMessage(input) {
  return input?.user_message || input?.message || input?.prompt || '';
}

export function resolveProjectSource(projectDir) {
  try {
    const remote = execSync('git remote get-url origin', {
      cwd: projectDir,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim().replace(/\.git$/, '');
    const sshPath = remote.match(/^[^@]+@[^:]+:(.+)$/)?.[1];
    const rawPath = sshPath ?? remote.replace(/^[^:]+:\/\//, '').replace(/^[^@/]+@/, '').replace(/^[^/]+\/+/, '');
    const segments = rawPath.split('/').filter(Boolean);
    if (segments.length >= 2) return `${segments.at(-2)}/${segments.at(-1)}`;
  } catch {
    // fall through
  }
  return `local/${basename(projectDir)}`;
}

export function coralProjectDir(projectDir) {
  return join(homedir(), '.coral', 'projects', resolveProjectSource(projectDir).replace(/\//g, '-'));
}

export function resolveKbRoot() {
  const custom = process.env.CORAL_KB_PATH;
  if (custom) return custom.startsWith('~') ? join(homedir(), custom.slice(1)) : custom;
  return join(homedir(), '.coral', buildFlavor() === 'dev' ? 'kb-dev' : 'kb');
}

function coralDataDir(flavor) {
  return join(homedir(), '.coral', flavor === 'dev' ? 'data-dev' : 'data');
}

export function kbRuntimeDir(flavor = buildFlavor()) {
  return join(coralDataDir(flavor), 'kb');
}

export function storeDbPath(flavor = buildFlavor()) {
  return join(coralDataDir(flavor), 'store', 'store.db');
}

function corpusStoreDbPathFromInput(inputPath) {
  if (typeof inputPath !== 'string' || inputPath.length === 0) return null;
  if (basename(inputPath) === 'kb') return join(dirname(inputPath), 'store', 'store.db');
  return inputPath;
}

let _betterSqlite3;
let _betterSqlite3Loaded = false;

function loadBetterSqlite3() {
  if (_betterSqlite3Loaded) return _betterSqlite3;
  _betterSqlite3Loaded = true;
  try {
    _betterSqlite3 = require('better-sqlite3');
  } catch {
    _betterSqlite3 = null;
  }
  return _betterSqlite3;
}

function sqliteInteger(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'bigint') {
    const numberValue = Number(value);
    return Number.isSafeInteger(numberValue) ? numberValue : null;
  }
  return null;
}

export function readCorpusSnapshotStamp(dbPath) {
  try {
    const resolvedDbPath = corpusStoreDbPathFromInput(dbPath);
    if (!resolvedDbPath) return null;

    const BetterSqlite3 = loadBetterSqlite3();
    if (!BetterSqlite3) return null;

    const db = new BetterSqlite3(resolvedDbPath, { readonly: true, fileMustExist: true });
    try {
      const row = db
        .prepare(
          `SELECT snapshot_id AS snapshotId,
                  content_seq AS contentSeq,
                  metadata_seq AS metadataSeq,
                  content_manifest_hash AS contentManifestHash,
                  metadata_manifest_hash AS metadataManifestHash
             FROM kb_corpus_state
            WHERE id = 1
            LIMIT 1`,
        )
        .get();
      if (!row) return null;

      const contentSeq = sqliteInteger(row.contentSeq);
      const metadataSeq = sqliteInteger(row.metadataSeq);
      if (
        typeof row.snapshotId !== 'string' ||
        contentSeq === null ||
        metadataSeq === null ||
        typeof row.contentManifestHash !== 'string' ||
        typeof row.metadataManifestHash !== 'string'
      ) {
        return null;
      }

      return {
        snapshotId: row.snapshotId,
        contentSeq,
        metadataSeq,
        contentManifestHash: row.contentManifestHash,
        metadataManifestHash: row.metadataManifestHash,
      };
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

const IDENT_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

export function isValidSessionId(value) {
  return typeof value === 'string' && value.length > 0 && IDENT_PATTERN.test(value);
}

export function readMemoOwnerFromFrontmatter(content) {
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fmMatch) return undefined;
  const ownerMatch = fmMatch[1].match(/^owner:\s*(.+)$/m);
  if (!ownerMatch) return undefined;
  const raw = ownerMatch[1].trim();
  if (!IDENT_PATTERN.test(raw)) throw new Error('Invalid owner in frontmatter');
  return raw;
}

export function sweepStale(dir, prefix, ttlMs) {
  try {
    const now = Date.now();
    for (const f of readdirSync(dir)) {
      if (!f.startsWith(prefix)) continue;
      const p = join(dir, f);
      if (now - statSync(p).mtimeMs > ttlMs) try { unlinkSync(p); } catch {}
    }
  } catch {}
}
