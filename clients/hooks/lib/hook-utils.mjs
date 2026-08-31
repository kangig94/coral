import { execSync } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
} from 'node:fs';
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

export const ACCEPTED_FLAVORS = Object.freeze(['prod', 'dev']);

let _cachedFlavor;

function readBuildFlavorState() {
  if (_cachedFlavor !== undefined) return { flavor: _cachedFlavor };

  const here = fileURLToPath(import.meta.url);
  const manifest = resolve(dirname(here), '..', '..', 'bridge', 'manifest.json');
  const parsed = parseManifestFlavor(manifest);
  _cachedFlavor = parsed ?? 'prod';
  return { flavor: _cachedFlavor };
}

export function buildFlavor() {
  return readBuildFlavorState().flavor;
}

export function resolveFlavorDisposition() {
  const requested = process.env.CORAL_FLAVOR;
  if (requested !== undefined && !ACCEPTED_FLAVORS.includes(requested)) {
    return { kind: 'unrecognized', value: requested };
  }

  const actual = readBuildFlavorState();
  if (actual.flavor !== (requested ?? 'prod')) return { kind: 'other-flavor' };
  return { kind: 'active' };
}

export function exitIfWrongFlavor() {
  if (resolveFlavorDisposition().kind !== 'active') process.exit(0);
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

function hookOutputForHost(value) {
  if (hostKind() !== 'copilot') return value;
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
  const remainder =
    envelope.hookEventName === undefined ? retained : { hookEventName: envelope.hookEventName, ...retained };
  return { ...rest, ...hoisted, hookSpecificOutput: remainder };
}

// Memoized per hook invocation: callers resolve the same projectDir several
// times (inject rendering, wake-up slug, project dir), and each miss costs a
// git subprocess with a 2s timeout — repeated timeouts would eat the hook budget.
const _projectSourceCache = new Map();
/**
 * When a root last failed to produce an answer, so a second call site within the same hook process is held
 * off from re-forking git rather than paying the timeout again. No size cap, unlike
 * `PROJECT_SOURCE_MAP_MAX_ENTRIES` on the `src/` twin: that Map lives in a long-running daemon that resolves
 * many project roots over its lifetime, where an eviction policy matters. This one lives inside a single hook
 * process that resolves one `projectDir` and exits with the process — it holds at most one entry, ever.
 */
const _projectSourceUnanswered = new Map();
// Errnos from a failed subprocess *launch* that are a standing fact about this machine rather than about this
// moment: the binary is not installed, not executable, or the working directory is not one. None changes while
// a hook session runs — but standing is not decisive. A domain probe (does this project have a remote?) that
// fails to launch git for one of these reasons has learned nothing about the remote, only that it could not
// ask; `computeProjectSource` below treats every code in this set exactly like any other failed launch,
// `{ answered: false }`, held only for the reprobe window. A caller whose own question IS "can this binary be
// launched here" is the exception and may read this set directly: for that question, membership is itself the
// decisive answer rather than an unanswered probe, and such a caller owns its own fallback.
//
// The list is the standing side on purpose — a missed entry costs a re-probe, where listing the transient side
// instead makes every unlisted errno a durable wrong answer nobody can see.
//
// The same enumeration as `STANDING_PROBE_ERRNOS` in `src/infra/process-constants.ts`, spelled again because
// hooks may not import from `src/`, and asserted equal by `tests/unit/hooks/hook-project-source.test.ts`.
// It is the hook lane's one home for the set.
export const STANDING_PROBE_ERRNOS = new Set(['ENOENT', 'EACCES', 'EPERM', 'ENOTDIR']);
// Same value as `INDECISIVE_PROBE_REPROBE_INTERVAL_MS` (`src/infra/process-constants.ts`), spelled again for
// the reason `STANDING_PROBE_ERRNOS` above is, and asserted equal by the same test,
// `tests/unit/hooks/hook-project-source.test.ts`.
export const UNANSWERED_REPROBE_INTERVAL_MS = 60_000;

/**
 * The project's `<owner>/<repo>`, or `local/<basename>` when there is no remote to read.
 *
 * This string is an identity, not a label: `coralProjectDir` below turns it into
 * `~/.coral/projects[-dev]/<slug>` with the same rule the daemon uses (`sourceToSlug` in
 * `src/infra/path/index.ts`), and that directory holds memos and is exported to every skill as
 * `CORAL_PROJECT`. So the two lanes must agree.
 *
 * A non-answer is held for `UNANSWERED_REPROBE_INTERVAL_MS`.
 *
 * That hold's value is scoped to a single hook invocation, not to a session: `_projectSourceUnanswered` is a
 * plain module-level Map, and every hook event is a fresh `node` process with its own empty one — nothing here
 * persists, or needs to, across separate hook calls. The interval only has to outlast one hook's own timeout
 * budget to do this — which it does by a wide margin (60s against a process that lives a few seconds at most),
 * not the other way around.
 */
export function resolveProjectSource(projectDir) {
  const cached = _projectSourceCache.get(projectDir);
  if (cached !== undefined) return cached;

  const local = `local/${basename(projectDir)}`;
  const unansweredAt = _projectSourceUnanswered.get(projectDir);
  if (unansweredAt !== undefined && Date.now() - unansweredAt < UNANSWERED_REPROBE_INTERVAL_MS) return local;

  const probe = computeProjectSource(projectDir, local);
  if (!probe.answered) {
    _projectSourceUnanswered.set(projectDir, Date.now());
    return local;
  }
  _projectSourceUnanswered.delete(projectDir);
  _projectSourceCache.set(projectDir, probe.source);
  return probe.source;
}

/**
 * `{ answered: true, source }` when git ran and reported — including the ordinary "not a repository" and "no
 * such remote" exits — and `{ answered: false }` when it could not be asked. `execSync` throws with a numeric
 * `status` only in the first case; a timeout or a failed launch — including one of `STANDING_PROBE_ERRNOS`,
 * which says the launch will fail the same way again but says nothing about whether this project has a remote
 * — carries a string `code` and `status: null`, and is `{ answered: false }` here too.
 */
function computeProjectSource(projectDir, local) {
  let remote;
  try {
    remote = execSync('git remote get-url origin', {
      cwd: projectDir,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 2000,
    });
  } catch (err) {
    return typeof err?.status === 'number' ? { answered: true, source: local } : { answered: false };
  }

  return { answered: true, source: parseRemoteSource(remote) ?? local };
}

function parseRemoteUrlPath(remote) {
  try {
    return new URL(remote).pathname.replace(/^\/+/, '').replace(/\/+$/, '');
  } catch {
    return null;
  }
}

/**
 * A remote URL as `<owner>/<repo>`, or `null` when it names no such pair.
 *
 * Rule for rule the same as `parseRemoteSource` in `src/infra/project-source.ts`, because the two lanes name
 * the same directory. Exported only so a single table in
 * `tests/unit/hooks/hook-project-source.test.ts` can drive both implementations: hooks may not import from
 * `src/`, so this rule has to be written twice.
 */
export function parseRemoteSource(remote) {
  const normalized = remote
    .trim()
    .replace(/\/+$/, '')
    .replace(/\.git$/, '');
  if (!normalized) return null;

  const sshPath = normalized.match(/^[^@]+@[^:]+:(.+)$/)?.[1];
  const rawPath = sshPath ?? parseRemoteUrlPath(normalized);
  if (!rawPath) return null;

  const segments = rawPath.split('/').filter((segment) => segment.length > 0);
  if (segments.length < 2) return null;

  return `${segments[segments.length - 2]}/${segments[segments.length - 1]}`;
}

/**
 * `~/.coral/projects[-dev]/<slug>` — the same directory `projectsPaths` (`src/infra/path/index.ts`) derives.
 *
 * `tests/invariants/flavor-path-separation.test.ts` enforces this separation "uniformly" and scans `src/` only.
 */
export function coralProjectDir(projectDir) {
  const projectsRoot = buildFlavor() === 'dev' ? 'projects-dev' : 'projects';
  return join(coralStateRoot(), projectsRoot, resolveProjectSource(projectDir).replace(/\//g, '-'));
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

export const PROJECT_IGNORE_SPAWN_TIMEOUT_MS = 5000;
export const PROJECT_IGNORE_CONTEXT_PROBE_BUDGET_MS = 1500;
export const PROJECT_IGNORE_LOCK_WRAPPER_BUDGET_MS = 250;
export const PROJECT_IGNORE_STAGING_ARENA_MAX_AGE_MS = 600_000;
export const PROJECT_IGNORE_ARENA_SWEEP_BUDGET_MS = 250;
export const PROJECT_IGNORE_ARENA_SWEEP_MAX_RUNS = 32;
export const PROJECT_IGNORE_LOCK_CONFLICT_EXIT_CODE = 75;

export function projectIgnoreContextProbeDeadline(startedNs) {
  try {
    return BigInt(startedNs) + BigInt(PROJECT_IGNORE_CONTEXT_PROBE_BUDGET_MS) * 1_000_000n;
  } catch {
    return null;
  }
}

export function projectIgnoreStagingDir() {
  return join(coralStateRoot(), 'staging', 'project-ignore');
}

export function projectIgnoreMaintenanceLockPath() {
  return join(coralStateRoot(), 'staging', 'project-ignore.maintenance.lock');
}

function ensureRealDirectoryComponent(path) {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
    chmodSync(path, 0o700);
    return true;
  } catch (error) {
    if (error?.code !== 'ENOENT') return false;
  }

  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== 'EEXIST') return false;
  }

  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
    chmodSync(path, 0o700);
    return true;
  } catch {
    return false;
  }
}

function prepareCoralStateDirectory(components) {
  try {
    const stateRoot = coralStateRoot();
    const home = realpathSync(dirname(stateRoot));
    const expectedStateRoot = join(home, basename(stateRoot));
    if (!ensureRealDirectoryComponent(expectedStateRoot)) return null;
    let canonicalStateRoot = realpathSync(stateRoot);
    if (canonicalStateRoot !== expectedStateRoot) return null;
    for (const component of components) {
      const expectedComponent = join(canonicalStateRoot, component);
      if (!ensureRealDirectoryComponent(expectedComponent)) return null;
      canonicalStateRoot = realpathSync(expectedComponent);
      if (canonicalStateRoot !== expectedComponent) return null;
    }
    return canonicalStateRoot;
  } catch {
    return null;
  }
}

function prepareProjectIgnoreStateStagingDir() {
  return prepareCoralStateDirectory(['staging']);
}

export function prepareCoralProjectDir(target) {
  const projectsRootName = buildFlavor() === 'dev' ? 'projects-dev' : 'projects';
  const projectsRoot = join(coralStateRoot(), projectsRootName);
  if (target === projectsRoot || dirname(target) !== projectsRoot) return null;
  const projectName = basename(target);
  if (join(projectsRoot, projectName) !== target) return null;
  return prepareCoralStateDirectory([projectsRootName, projectName]);
}

export function prepareProjectIgnoreStagingDir() {
  const stagingDir = prepareProjectIgnoreStateStagingDir();
  if (!stagingDir) return null;
  const arena = join(stagingDir, basename(projectIgnoreStagingDir()));
  if (!ensureRealDirectoryComponent(arena)) return null;
  try {
    const canonicalArena = realpathSync(arena);
    return canonicalArena === arena ? canonicalArena : null;
  } catch {
    return null;
  }
}

export function openProjectIgnoreMaintenanceLock() {
  const stagingDir = prepareProjectIgnoreStateStagingDir();
  if (!stagingDir) return null;

  const lockPath = projectIgnoreMaintenanceLockPath();
  let fd;
  try {
    try {
      const named = lstatSync(lockPath);
      if (named.isSymbolicLink() || !named.isFile()) return null;
      chmodSync(lockPath, 0o600);
    } catch (error) {
      if (error?.code !== 'ENOENT') return null;
    }
    fd = openSync(
      lockPath,
      constants.O_RDWR | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    const opened = fstatSync(fd);
    const named = lstatSync(lockPath);
    if (
      !opened.isFile() ||
      named.isSymbolicLink() ||
      !named.isFile() ||
      opened.dev !== named.dev ||
      opened.ino !== named.ino
    ) {
      closeSync(fd);
      return null;
    }
    fchmodSync(fd, 0o600);
    return fd;
  } catch {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {}
    }
    return null;
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
      if (now - statSync(p).mtimeMs > ttlMs)
        try {
          unlinkSync(p);
        } catch {}
    }
  } catch {}
}
