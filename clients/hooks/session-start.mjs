#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
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
} from './lib/project-ignore/notices.mjs';
import { isProjectIgnoreResult } from './lib/project-ignore/result.mjs';
import {
  LOCK_CONFLICT_EXIT_CODE,
  LOCK_UNAVAILABLE_EXIT_CODE,
  SPAWN_TIMEOUT_MS,
} from './lib/project-ignore/arena.mjs';

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
const STARTUP_FAILURE_NOTICE_WINDOW_MS = 5 * 60 * 1000;
const STARTUP_FAILURE_CODE_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const MAX_STARTUP_FAILURE_CODE_LENGTH = 128;

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
    // A backend spawned without an attempt id cannot be told apart from anyone else's once it delegates: the
    // coordinator that finally binds may be a third build, and then the id is the only evidence tying it back
    // to this spawn. Every minter of this variable draws from one namespace in which no two attempts may
    // collide, so it has to be unique across processes without coordination — `randomUUID` is CSPRNG-backed
    // and satisfies that. See `spawnCoordinator` in `src/transport/ipc/ensure.ts`.
    const child = spawn(process.execPath, [backendBin], {
      detached: true,
      stdio: ['ignore', 'ignore', stderr],
      env: { ...process.env, CORAL_STARTUP_ATTEMPT_ID: randomUUID() },
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
// who just fixed the cause would be told it is still broken.
//
// The recency and liveness filters remain, as noise control rather than proof: an
// answering daemon or an old diagnostic means the report is not worth making.
//
// The notice may point only at what this hook itself observed, and what it observed is
// the diagnostic file. Naming a command instead promises an answer that depends on
// evidence this hook does not have.
function readRecentStartupFailureNotice(runDir) {
  const diagnosticFile = join(runDir, 'startup-diagnostic.json');
  try {
    if (isCoordinatorAlive(runDir) !== false) return null;
    const diagnostic = JSON.parse(readFileSync(diagnosticFile, 'utf-8'));
    if (diagnostic?.schemaVersion !== 1) return null;
    if (diagnostic.state !== 'stopped_with_diagnostic' || diagnostic.retryable !== false) return null;
    const recordedAt = Date.parse(diagnostic.recordedAt);
    if (!Number.isFinite(recordedAt)) return null;
    const age = Date.now() - recordedAt;
    if (age < 0 || age > STARTUP_FAILURE_NOTICE_WINDOW_MS) return null;
    const error = diagnostic.error;
    if (error?.kind !== 'coral_setup_error') return null;
    const code = error.code;
    if (
      typeof code !== 'string' ||
      code.length === 0 ||
      code.length > MAX_STARTUP_FAILURE_CODE_LENGTH ||
      !STARTUP_FAILURE_CODE_PATTERN.test(code)
    ) {
      return null;
    }
    return `Coral backend: the most recent start attempt failed, and a fresh attempt was just issued. It may already be resolved.\nError code: ${code}\nThe failed attempt recorded this at ${diagnosticFile}.`;
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
    ['cleaned', 'refused'].includes(legacySweep?.state) && legacySweep?.count > 0
      ? `Coral project-ignore maintenance removed ${legacySweep.count} authorized legacy staging file(s): .gitignore.coral-<pid>-<timestamp>.tmp beside the Git-root .gitignore or project .claude/.gitignore, and coral.coral-<pid>-<timestamp>.tmp beside project .claude/coral.`
      : null;
  const ignoreFailure = projectIgnoreOutcomeNotice(ignoreOutcome.outcome);
  const ignoreRefusalNotices = renderProjectIgnoreResultNotices(ignoreOutcome.maintenance);
  const ignoreNotice =
    ignoreRefusalNotices.length > 0
      ? [
          'Coral project-ignore maintenance:',
          ...ignoreRefusalNotices,
          ignoreFailure ? `Coral project-ignore maintenance ${ignoreFailure}.` : null,
        ]
          .filter(Boolean)
          .join('\n')
      : ignoreFailure
        ? `Coral project-ignore maintenance ${ignoreFailure}.`
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
      timeout: SPAWN_TIMEOUT_MS,
      maxBuffer: 16 * 1024,
    });
    if (result.error) {
      if (result.error.code === 'ETIMEDOUT') return { outcome: 'killed', maintenance: null };
      return { outcome: 'maintenance-lock-unavailable', maintenance: null };
    }
    if (result.status === LOCK_CONFLICT_EXIT_CODE) {
      return { outcome: 'maintenance-busy', maintenance: null };
    }
    if (
      !result.stdout &&
      [LOCK_UNAVAILABLE_EXIT_CODE, 126, 127].includes(result.status)
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
