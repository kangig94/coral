#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  buildFlavor,
  claudeConfigDir,
  coralStateRoot,
  exitIfChildProcess,
  exitIfWrongFlavor,
  hostKind,
  isValidSessionId,
  readStdin,
  resolveKbRoot,
  resolveProjectSource,
  writeHookOutput,
} from './lib/hook-utils.mjs';
import { resolveEquippedTools } from './lib/equip-tools.mjs';
import { renderInject } from './lib/inject-render.mjs';
import { readProjectScopedWakeUp } from './lib/wake-up-read.mjs';
import { isKbEnabled } from './lib/kb-toggle.mjs';

// Unconditionally spawn coral-backend on session start. The daemon's own
// socket-as-lock contention is the single source of truth for staleness:
//   - matching incumbent (same bundle/flavor/namespace) -> new daemon throws
//     BackendAlreadyRunningError and exits without touching the live process
//   - mismatching bundle -> bindWithHandoff sends transport.shutdown and the
//     new daemon takes over the bound socket
// Letting the daemon's contention layer decide keeps the hook free of
// bundle/flavor comparison logic that would otherwise drift from the daemon's
// `requestIncumbentShutdown` decision.

const LOG_ROTATE_THRESHOLD_BYTES = 2 * 1024 * 1024;
const PROJECT_IGNORE_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'project-ignore.mjs');
/**
 * What the child is allowed, and why it is not the sum of what the child spends.
 *
 * `project-ignore.mjs` pays two bounded git forks on its ordinary path: `git rev-parse --show-toplevel`
 * (1500ms, to find the ignore root) and `git remote get-url origin` (2000ms, to derive the project directory
 * the symlink must point at). That is 3500ms of child work before its own Node startup. A budget equal to the
 * work it bounds is not a budget: a child doing nothing wrong, on a slow mount, would be SIGTERMed while its
 * own bounds were still running.
 *
 * The margin goes here rather than into shrinking either probe, because shortening those trades a correct
 * answer for headroom that belongs to the caller: a probe cut short reports "could not tell" for a machine
 * that was merely slow. This hook is registered with a 10s timeout, and 5000ms is not the only cost charged
 * against it: `renderInject` pays a further 2000ms `git remote get-url origin` of its own, in this same process
 * rather than the child (`resolveProjectSource`, `hook-utils.mjs`) — so the two hard-bounded subprocess costs
 * alone already sum to 7000ms, leaving well under half of the registered budget for this process's own Node
 * startup and everything else this file does, not half of it.
 *
 * `tests/unit/hooks/project-ignore-symlink.test.ts` pins the child's 3500ms sum by reading both mocks' actual
 * options, and separately asserts this constant is strictly greater than that sum; if either bound moves, one
 * of those tests fails and the number here has to be re-derived rather than guessed.
 */
const PROJECT_IGNORE_SPAWN_TIMEOUT_MS = 5000;
// Long enough to still catch the failure when a session starts minutes after the
// user's last attempt, short enough that a cured problem stops being reported.
const STARTUP_FAILURE_NOTICE_WINDOW_MS = 10 * 60 * 1000;

function rotateLogIfLarge(runDir) {
  const path = join(runDir, 'coordinator.log');
  const archive = `${path}.1`;
  try {
    if (statSync(path).size < LOG_ROTATE_THRESHOLD_BYTES) return;
    try {
      unlinkSync(archive);
    } catch {
      // no prior archive
    }
    renameSync(path, archive);
  } catch {
    // no current log, or fs error: fail-open and let openSync create a fresh one
  }
}

function coordinatorRunDir(flavor = buildFlavor(), stateRoot = coralStateRoot()) {
  return join(stateRoot, 'gen2', flavor === 'dev' ? 'run-dev' : 'run');
}

function spawnBackend(pluginRoot) {
  // Match `src/infra/path/coordinator.ts:coordinatorPaths(...)`: the daemon
  // reads/writes coordinator.json here, so its stderr log belongs alongside
  // the same runDir. Sharing the path with `src/transport/ipc/ensure.ts`'s
  // CLI-side spawn keeps logs unified across both spawn entry points and
  // benefits from the same rotation discipline.
  const runDir = coordinatorRunDir();

  const backendBin = join(pluginRoot, 'bridge', 'coral-backend.cjs');
  let stderr = 'ignore';
  try {
    mkdirSync(runDir, { recursive: true });
    rotateLogIfLarge(runDir);
    stderr = openSync(join(runDir, 'coordinator.log'), 'a');
  } catch {}
  try {
    const child = spawn(process.execPath, [backendBin], {
      detached: true,
      stdio: ['ignore', 'ignore', stderr],
    });
    child.unref();
  } catch {}
}

function isCoordinatorAlive(runDir) {
  try {
    const record = JSON.parse(readFileSync(join(runDir, 'coordinator.json'), 'utf-8'));
    if (typeof record?.pid !== 'number') return null;
    process.kill(record.pid, 0);
    return true;
  } catch {
    return false;
  }
}

// The spawn above is detached, so this hook never learns whether it worked, and a
// failure has until now been invisible: the daemon writes a diagnostic and exits,
// the hook fails open, and the session proceeds as if Coral were healthy.
//
// The notice deliberately does not claim the backend is currently down. It cannot
// know: the spawn issued moments ago has not had time to bind, so no daemon is
// answering yet on every session start, and nothing ever deletes the diagnostic.
// Predicting from those signals is wrong exactly on the recovery path — someone
// who just fixed the cause would be told it is still broken. Reporting the last
// failure and its remedy is true whether or not it has since been resolved.
//
// The recency and liveness filters remain, as noise control rather than proof: an
// answering daemon or an old diagnostic means the report is not worth making. The
// window is deliberately wider than the daemon's own 5-minute probe horizon
// (`statusFromStartupDiagnostic`) because a session may start minutes after the
// user's last attempt; that divergence is intended, not drift.
function readRecentStartupFailureNotice(runDir) {
  try {
    if (isCoordinatorAlive(runDir) !== false) return null;
    const diagnostic = JSON.parse(readFileSync(join(runDir, 'startup-diagnostic.json'), 'utf-8'));
    if (diagnostic?.schemaVersion !== 1) return null;
    if (diagnostic.state !== 'stopped_with_diagnostic' || diagnostic.retryable !== false) return null;
    const recordedAt = Date.parse(diagnostic.recordedAt);
    if (!Number.isFinite(recordedAt)) return null;
    const age = Date.now() - recordedAt;
    if (age < 0 || age > STARTUP_FAILURE_NOTICE_WINDOW_MS) return null;
    const error = diagnostic.error;
    // Only documented setup errors carry authored, user-safe text; an arbitrary
    // bootstrap exception's message stays in the coordinator log.
    if (error?.kind !== 'coral_setup_error') return null;
    if (typeof error.userMessage !== 'string' || typeof error.remediation !== 'string') return null;
    return `Coral backend: the most recent start attempt failed, and a fresh attempt was just issued. If Coral turns out to be unavailable this session, this is the cause and the remedy — it may already be resolved.\nCause: ${error.userMessage}\nRemedy: ${error.remediation}`;
  } catch {
    return null;
  }
}

exitIfChildProcess();
exitIfWrongFlavor();

try {
  const input = JSON.parse(await readStdin());
  const sessionId = input.session_id;
  if (!isValidSessionId(sessionId)) process.exit(0);

  const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || '';
  if (!PLUGIN_ROOT || !existsSync(PLUGIN_ROOT)) process.exit(0);

  spawnBackend(PLUGIN_ROOT);

  const projectDir = process.env.CLAUDE_PROJECT_DIR;
  ensureCliPermission();
  const ignoreOutcome = projectDir
    ? runProjectIgnoreMaintenance(projectDir, process.env.CORAL_AUTO_SYMLINK === '1')
    : { outcome: 'no-project-dir', maintenance: null };

  const kbEnabled = isKbEnabled();
  const injectContent = renderInject({
    pluginRoot: PLUGIN_ROOT,
    projectDir,
    sessionId,
    asOwner: true,
    kbEnabled,
    equippedTools: resolveEquippedTools(),
  });

  const host = hostKind();

  const projectSlug = projectDir ? resolveProjectSource(projectDir).replace(/\//g, '-') : undefined;
  const wakeUpPayload = kbEnabled && projectSlug ? readProjectScopedWakeUp(resolveKbRoot(), projectSlug) : null;
  const migrationNotice = ignoreOutcome.maintenance?.migrated
    ? '\n\nCoral migration: moved the generated coral ignore rule from the Git-root .gitignore into .claude/.gitignore.'
    : '';
  const startupFailureNotice = readRecentStartupFailureNotice(coordinatorRunDir());
  const head = `SessionStart:session_id=${sessionId}\nCurrent host: ${host}\nClaude config dir: ${claudeConfigDir()}\n\n${injectContent}${migrationNotice}`;
  const body = wakeUpPayload === null ? head : `${head}\n\n${wakeUpPayload}`;
  const additionalContext = startupFailureNotice === null ? body : `${startupFailureNotice}\n\n${body}`;

  writeHookOutput({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext,
    },
  });
} catch {
  process.exit(0);
}

// `result.error` alone would still conflate a timeout kill with a launch that never started: Node sets
// `result.signal` to the kill signal only in the former case, leaving it `null` in the latter, so the two are
// told apart here rather than left for the caller to guess from a shared `null`.
function runProjectIgnoreMaintenance(projectDir, createSymlink) {
  try {
    const args = [PROJECT_IGNORE_SCRIPT, '--project-dir', projectDir];
    if (createSymlink) args.push('--create-symlink');
    const result = spawnSync(process.execPath, args, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: PROJECT_IGNORE_SPAWN_TIMEOUT_MS,
      maxBuffer: 16 * 1024,
    });
    if (result.error) return { outcome: result.signal ? 'killed' : 'not-spawned', maintenance: null };
    if (!result.stdout) return { outcome: 'no-output', maintenance: null };
    const parsed = JSON.parse(result.stdout);
    return { outcome: 'ok', maintenance: parsed && typeof parsed === 'object' ? parsed : null };
  } catch {
    return { outcome: 'unparseable-output', maintenance: null };
  }
}

function ensureCliPermission() {
  const rule = 'Bash(node *coral-cli*)';
  const dir = claudeConfigDir();
  const file = join(dir, 'settings.json');
  try {
    const settings = existsSync(file) ? JSON.parse(readFileSync(file, 'utf-8')) : {};
    const allow = settings.permissions?.allow ?? [];
    if (allow.includes(rule)) return;
    if (!settings.permissions) settings.permissions = {};
    if (!settings.permissions.allow) settings.permissions.allow = [];
    settings.permissions.allow.push(rule);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
  } catch {
    // fail-open
  }
}
