#!/usr/bin/env node

import { execSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import {
  buildFlavor,
  coralProjectDir,
  exitIfChildProcess,
  exitIfWrongFlavor,
  isValidSessionId,
  readStdin,
  resolveKbRoot,
  resolveProjectSource,
} from './lib/hook-utils.mjs';
import { renderInject } from './lib/inject-render.mjs';
import { readProjectScopedWakeUp } from './lib/wake-up-read.mjs';

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

function spawnBackend(pluginRoot) {
  // Match `src/infra/path/coordinator.ts:coordinatorPaths(...)`: the daemon
  // reads/writes coordinator.json here, so its stderr log belongs alongside
  // the same runDir. Sharing the path with `src/transport/ipc/ensure.ts`'s
  // CLI-side spawn keeps logs unified across both spawn entry points and
  // benefits from the same rotation discipline.
  const runDir = join(homedir(), '.coral', buildFlavor() === 'dev' ? 'run-dev' : 'run');

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
  const gitRoot = projectDir ? findGitRoot(projectDir) : undefined;
  ensureCliPermission();
  if (projectDir && process.env.CORAL_AUTO_SYMLINK === '1') {
    ensureCoralSymlink(projectDir, gitRoot);
  }

  const injectContent = renderInject({
    pluginRoot: PLUGIN_ROOT,
    projectDir,
    sessionId,
    asOwner: true,
  });

  const aiAgent = process.env.AI_AGENT ?? '';
  const host = aiAgent.startsWith('claude') ? 'claude' : 'codex';

  const projectSlug = projectDir ? resolveProjectSource(projectDir).replace(/\//g, '-') : undefined;
  const wakeUpPayload = projectSlug ? readProjectScopedWakeUp(resolveKbRoot(), projectSlug) : null;
  const additionalContext = wakeUpPayload === null
    ? `SessionStart:session_id=${sessionId}\nCurrent host: ${host}\n\n${injectContent}`
    : `SessionStart:session_id=${sessionId}\nCurrent host: ${host}\n\n${injectContent}\n\n${wakeUpPayload}`;

  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext,
    },
  }));
} catch {
  process.exit(0);
}

function findGitRoot(cwd) {
  try {
    // Bound git rev-parse against pathological mounts (NFS / WSL slow fs).
    // Fail-open: any timeout, ENOENT, or non-zero exit returns undefined.
    return execSync('git rev-parse --show-toplevel', {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 2000,
    }).trim();
  } catch {
    return undefined;
  }
}

function addGitignoreEntry(projectDir, entry, gitRoot) {
  try {
    const baseDir = gitRoot ?? projectDir;
    const fullEntry = gitRoot && gitRoot !== projectDir
      ? join(relative(gitRoot, projectDir), entry)
      : entry;
    const gitignore = join(baseDir, '.gitignore');
    const content = existsSync(gitignore) ? readFileSync(gitignore, 'utf-8') : '';
    if (!content.split('\n').includes(fullEntry)) {
      writeFileSync(gitignore, content + (content.endsWith('\n') || !content ? '' : '\n') + fullEntry + '\n');
    }
  } catch {
    // fail-open
  }
}

function ensureCoralSymlink(projectDir, gitRoot) {
  const claudeDir = join(projectDir, '.claude');
  if (!existsSync(claudeDir)) return; // no .claude dir — nothing to link into
  const link = join(claudeDir, 'coral');
  const target = coralProjectDir(projectDir);
  try {
    if (existsSync(link)) return;
    mkdirSync(target, { recursive: true });
    symlinkSync(target, link);
  } catch {
    return; // lost race or fs error — skip gitignore
  }
  addGitignoreEntry(projectDir, '.claude/coral', gitRoot);
}

function ensureCliPermission() {
  const rule = 'Bash(node *coral-cli*)';
  const dir = join(homedir(), '.claude');
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
