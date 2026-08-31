#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  ACCEPTED_FLAVORS,
  buildFlavor,
  claudeConfigDir,
  coralStateRoot,
  exitIfChildProcess,
  hostKind,
  isValidSessionId,
  PROJECT_IGNORE_LOCK_CONFLICT_EXIT_CODE,
  PROJECT_IGNORE_LOCK_UNAVAILABLE_EXIT_CODE,
  PROJECT_IGNORE_SPAWN_TIMEOUT_MS,
  readStdin,
  resolveFlavorDisposition,
  writeHookOutput,
} from './lib/hook-utils.mjs';
import { fitAdditionalContext, truncateUtf8 } from './lib/additional-context.mjs';
import { resolveEquippedTools } from './lib/equip-tools.mjs';
import { renderInject } from './lib/inject-render.mjs';
import {
  projectIgnoreOutcomeNotice,
  renderProjectIgnoreResultNotices,
} from './lib/project-ignore-notices.mjs';
import { isProjectIgnoreResult } from './lib/project-ignore-result.mjs';

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
const MAX_REPORTED_FLAVOR_BYTES = 160;
const PROJECT_IGNORE_OWNER_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'project-ignore-owner.mjs');
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
const flavorDisposition = resolveFlavorDisposition();
if (flavorDisposition.kind === 'unrecognized') {
  const acceptedFlavors = ACCEPTED_FLAVORS.map((flavor) => `'${flavor}'`).join(' and ');
  const reportedFlavor = truncateUtf8(flavorDisposition.value, MAX_REPORTED_FLAVOR_BYTES, '… [truncated]');
  const additionalContext = fitAdditionalContext({
    fixedContent: `Coral hooks are inert: CORAL_FLAVOR is set to '${reportedFlavor}', but only ${acceptedFlavors} are accepted. Every Coral hook will remain inert until CORAL_FLAVOR is corrected.`,
    variableContent: '',
    trimNotice: '',
  });
  writeHookOutput({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext,
    },
  });
  process.exit(0);
}
if (flavorDisposition.kind === 'other-flavor') process.exit(0);

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

  const injectContent = renderInject({
    pluginRoot: PLUGIN_ROOT,
    projectDir,
    sessionId,
    asOwner: true,
    group: 'base',
    equippedTools: resolveEquippedTools(),
  });

  const host = hostKind();

  const migrationPublished = [
    ignoreOutcome.maintenance?.artifacts.scopedIgnoreRetraction,
    ignoreOutcome.maintenance?.artifacts.rootIgnoreRetraction,
  ].some((artifact) => artifact?.state === 'published');
  const migrationNotice = migrationPublished
    ? 'Coral migration: retracted legacy coral ignore rule(s) from the working tree; the canonical anchored rule is in .git/info/exclude.'
    : null;
  const legacySweep = ignoreOutcome.maintenance?.artifacts.legacySweep;
  const legacySweepNotice =
    legacySweep?.state === 'cleaned'
      ? `Coral project-ignore maintenance removed ${legacySweep.count} authorized legacy staging file(s): .gitignore.coral-<pid>-<timestamp>.tmp beside the Git-root .gitignore or project .claude/.gitignore, and coral.coral-<pid>-<timestamp>.tmp beside project .claude/coral.`
      : legacySweep?.state === 'refused'
        ? `Coral project-ignore maintenance removed ${legacySweep.count} authorized legacy staging file(s), then could not remove authorized legacy staging path ${legacySweep.path}.`
        : null;
  const ignoreFailure = projectIgnoreOutcomeNotice(ignoreOutcome.outcome);
  const ignoreRefusalNotices = renderProjectIgnoreResultNotices(ignoreOutcome.maintenance);
  const ignoreNotice =
    ignoreFailure || ignoreRefusalNotices.length > 0
      ? `Coral project-ignore maintenance${ignoreFailure ? ` ${ignoreFailure}.` : ':'}${
          ignoreRefusalNotices.length > 0 ? `\n${ignoreRefusalNotices.join('\n')}` : ''
        }`
      : null;
  const startupFailureNotice = readRecentStartupFailureNotice(coordinatorRunDir());
  const fixedContent = `SessionStart:session_id=${sessionId}\nCurrent host: ${host}\nClaude config dir: ${claudeConfigDir()}\n\n${injectContent}`;
  const variableContent = [
    startupFailureNotice,
    migrationNotice,
    legacySweepNotice,
    ignoreNotice,
  ].filter(Boolean).join('\n\n');
  const additionalContext = fitAdditionalContext({
    fixedContent,
    variableContent,
    trimNotice:
      'Coral startup notices were trimmed to fit this hook payload; inspect the coordinator startup diagnostic and project ignore state for full details.',
  });

  writeHookOutput({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext,
    },
  });
} catch {
  process.exit(0);
}

function runProjectIgnoreMaintenance(projectDir, createSymlink) {
  try {
    const args = [
      PROJECT_IGNORE_OWNER_SCRIPT,
      '--started-ns',
      process.hrtime.bigint().toString(),
      '--project-dir',
      projectDir,
    ];
    if (createSymlink) args.push('--create-symlink');
    const result = spawnSync(process.execPath, args, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: PROJECT_IGNORE_SPAWN_TIMEOUT_MS,
      maxBuffer: 16 * 1024,
    });
    if (result.error) {
      if (result.error.code === 'ETIMEDOUT') return { outcome: 'killed', maintenance: null };
      return { outcome: 'maintenance-lock-unavailable', maintenance: null };
    }
    if (result.status === PROJECT_IGNORE_LOCK_CONFLICT_EXIT_CODE) {
      return { outcome: 'maintenance-busy', maintenance: null };
    }
    if (
      !result.stdout &&
      [PROJECT_IGNORE_LOCK_UNAVAILABLE_EXIT_CODE, 126, 127].includes(result.status)
    ) {
      return { outcome: 'maintenance-lock-unavailable', maintenance: null };
    }
    if (!result.stdout) return { outcome: 'no-output', maintenance: null };
    const parsed = JSON.parse(result.stdout);
    if (!isProjectIgnoreResult(parsed)) {
      return { outcome: 'unparseable-output', maintenance: null };
    }
    const expectedExitCode = parsed.status === 'complete' ? 0 : 1;
    if (result.status !== expectedExitCode) return { outcome: 'unparseable-output', maintenance: null };
    if (parsed.status === 'partial') return { outcome: 'partial', maintenance: parsed };
    if (parsed.status === 'refused') return { outcome: 'failed', maintenance: parsed };
    return { outcome: 'ok', maintenance: parsed };
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
