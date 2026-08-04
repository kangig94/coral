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

export function currentStoreFormatFingerprint() {
  try {
    const manifestPath = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bridge', 'manifest.json');
    const fingerprint = JSON.parse(readFileSync(manifestPath, 'utf8')).storeFormatFingerprint;
    return typeof fingerprint === 'string' && /^sha256:[a-f0-9]{64}$/.test(fingerprint) ? fingerprint : null;
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
  return new Promise((resolve) => {
    let data = '';
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
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

/**
 * Which CLI is running this hook. Codex and Copilot both export
 * `CLAUDE_PLUGIN_ROOT` as an OOTB compat alias, so the plugin root alone
 * cannot identify the host.
 *
 * Copilot is detected via `COPILOT_PLUGIN_ROOT` rather than `COPILOT_CLI`:
 * `COPILOT_CLI` is exported into *every* shell Copilot spawns (including
 * ordinary tool calls), so it leaks into unrelated child processes — e.g. a
 * Claude Code or Codex session, or a test runner, started from a Copilot
 * shell would be misdetected. `COPILOT_PLUGIN_ROOT` is set only when Copilot
 * invokes a plugin hook, which is exactly this scope.
 *
 * Codex is the by-elimination default: it is the one supported host that
 * announces itself with neither variable. A future fourth client would
 * therefore be reported as `codex`, which is safe for output shaping
 * (`hookOutputForHost` tests for `copilot` positively, so an unknown host
 * gets the Claude-shaped envelope) but would mis-report `Current host:` to
 * the model. Add a positive probe here when a fourth client lands.
 */
export function hostKind() {
  if (process.env.COPILOT_PLUGIN_ROOT) return 'copilot';
  if ((process.env.AI_AGENT ?? '').startsWith('claude')) return 'claude';
  return 'codex';
}

/**
 * Emits a hook result on stdout in the shape the current host understands.
 *
 * Claude Code and Codex namespace per-event fields under `hookSpecificOutput`.
 * Copilot CLI is split: it reads `additionalContext` only at the *top level*
 * and silently ignores an envelope, but reads `permissionDecision` /
 * `updatedInput` only *inside* the envelope and silently ignores them at the
 * top level. Both directions were A/B-verified against Copilot CLI 1.0.78 —
 * a wrapped `additionalContext` never reaches the model, and a flat
 * `updatedInput` never rewrites the command.
 *
 * So the transform hoists only the fields Copilot wants hoisted and leaves the
 * rest enveloped. Hook scripts keep emitting one canonical Claude-shaped
 * payload instead of branching per host at each call site.
 *
 * Already-flat shapes pass through untouched: Copilot honors Stop-hook
 * `decision: 'block'` with `reason` in exactly Claude's form (verified — a
 * blocked turn continues with `reason` as its instruction).
 */
export function writeHookOutput(value) {
  // `console.log` is built with `ignoreErrors: true`; a bare `process.stdout.write`
  // is not, and a closed pipe surfaces as an *asynchronous* 'error' event that no
  // surrounding try/catch can reach — which would crash a hook that is required to
  // fail open. Swallowing EPIPE restores the console semantics these sites had.
  silenceStdoutErrors();
  process.stdout.write(JSON.stringify(hookOutputForHost(value)) + '\n');
}

let stdoutErrorsSilenced = false;

function silenceStdoutErrors() {
  if (stdoutErrorsSilenced) return;
  stdoutErrorsSilenced = true;
  process.stdout.on('error', () => process.exit(0));
}

/** Envelope fields Copilot reads only at the top level. Everything else stays enveloped. */
const COPILOT_HOISTED_FIELDS = ['additionalContext'];

export function hookOutputForHost(value, host = hostKind()) {
  if (host !== 'copilot') return value;
  const envelope = value?.hookSpecificOutput;
  if (envelope === null || typeof envelope !== 'object' || Array.isArray(envelope)) return value;

  const hoisted = {};
  const retained = {};
  for (const [key, field] of Object.entries(envelope)) {
    if (key === 'hookEventName') continue; // Copilot infers the event from the registration
    if (COPILOT_HOISTED_FIELDS.includes(key)) hoisted[key] = field;
    else retained[key] = field;
  }
  if (Object.keys(hoisted).length === 0) return value;

  const { hookSpecificOutput: _envelope, ...rest } = value;
  if (Object.keys(retained).length === 0) return { ...rest, ...hoisted };
  // `hookEventName` is preserved here: the enveloped form Copilot was verified
  // to honor for `updatedInput` carried it.
  const remainder = envelope.hookEventName === undefined
    ? retained
    : { hookEventName: envelope.hookEventName, ...retained };
  return { ...rest, ...hoisted, hookSpecificOutput: remainder };
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
    })
      .trim()
      .replace(/\.git$/, '');
    const sshPath = remote.match(/^[^@]+@[^:]+:(.+)$/)?.[1];
    const rawPath =
      sshPath ??
      remote
        .replace(/^[^:]+:\/\//, '')
        .replace(/^[^@/]+@/, '')
        .replace(/^[^/]+\/+/, '');
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

// Coral daemon state is account-neutral. Provider credentials travel with each
// request and never select a different daemon or state tree.
export function coralStateRoot() {
  return join(homedir(), '.coral');
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
      if (now - statSync(p).mtimeMs > ttlMs)
        try {
          unlinkSync(p);
        } catch {}
    }
  } catch {}
}
