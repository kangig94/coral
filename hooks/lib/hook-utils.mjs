import { execSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
      timeout: 2000,
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
