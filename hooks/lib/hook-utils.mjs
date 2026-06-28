import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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

// Memoized per hook invocation: callers resolve the same projectDir several
// times (inject rendering, wake-up slug, project dir), and each miss costs a
// git subprocess with a 2s timeout — repeated timeouts would eat the hook budget.
const _projectSourceCache = new Map();

export function resolveProjectSource(projectDir) {
  const cached = _projectSourceCache.get(projectDir);
  if (cached !== undefined) return cached;
  const resolved = computeProjectSource(projectDir);
  _projectSourceCache.set(projectDir, resolved);
  return resolved;
}

function computeProjectSource(projectDir) {
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
  return join(coralStateRoot(), 'projects', resolveProjectSource(projectDir).replace(/\//g, '-'));
}

// Claude's config dir, honoring CLAUDE_CONFIG_DIR (set when launching `claude`,
// inherited by hooks and subprocesses). Falls back to ~/.claude.
export function claudeConfigDir() {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
}

// Per-config-dir state slot. MUST stay in lockstep with src `claudeConfigSlot`
// (src/infra/path/root.ts): the default config dir (~/.claude) maps to no slot
// (shared ~/.coral tree, backward compatible); any other config dir maps to
// sha256(configDir).slice(0,8). The daemon partitions its run/store/jobs/
// projects/exports by this slot, so every hook touching that state must resolve
// the same root via coralStateRoot().
function claudeConfigSlot() {
  const configDir = claudeConfigDir();
  if (configDir === join(homedir(), '.claude')) return undefined;
  return createHash('sha256').update(configDir).digest('hex').slice(0, 8);
}

// Root of Coral's daemon-owned state tree, partitioned by config-dir slot.
// Mirrors src `coralStateRoot`. The shared KB stays at ~/.coral (see
// resolveKbRoot) and must NOT route through here.
export function coralStateRoot() {
  const slot = claudeConfigSlot();
  const root = join(homedir(), '.coral');
  return slot ? join(root, 'by-config', slot) : root;
}

// Read the equipped-tools snapshot the daemon writes (src coordinatorPaths
// `equippedToolsFile`: <stateRoot>/<run|run-dev>/equipped-tools.json). Returns
// the well-formed { id, summary } entries, or [] on a missing/malformed file —
// fail open so a session never blocks on this advisory surface.
export function readEquippedToolsSnapshot() {
  try {
    const runDir = join(coralStateRoot(), buildFlavor() === 'dev' ? 'run-dev' : 'run');
    const parsed = JSON.parse(readFileSync(join(runDir, 'equipped-tools.json'), 'utf8'));
    // Contract lives in src/expansion/equipped-tools.ts as EQUIPPED_TOOLS_SNAPSHOT_VERSION.
    if (parsed?.version !== 1) return [];
    if (!Array.isArray(parsed.tools)) return [];
    return parsed.tools
      .filter((tool) => tool && typeof tool.id === 'string' && tool.id && typeof tool.summary === 'string' && tool.summary)
      .map((tool) => ({ id: tool.id, summary: tool.summary }));
  } catch {
    return [];
  }
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
