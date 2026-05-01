#!/usr/bin/env node
import { mkdirSync, openSync, realpathSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { exitIfChildProcess, exitIfWrongFlavor, readStdin } from './lib/hook-utils.mjs';

// Unconditionally spawn coral-backend on session start. The daemon's own
// `acquireLock` is the single source of truth for staleness:
//   - matching incumbent  -> new daemon throws BackendAlreadyRunningError and
//                            exits without touching the live process
//   - mismatching bundle  -> requestHandoff drains the incumbent and the new
//                            daemon takes over the lock
// Letting the contention layer decide keeps the hook free of bundle/flavor
// comparison logic that would otherwise drift from `inspectIncumbent`.

exitIfChildProcess();
exitIfWrongFlavor();

try {
  await readStdin();

  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  if (!pluginRoot) process.exit(0);

  let canonicalPluginRoot;
  try {
    canonicalPluginRoot = realpathSync(pluginRoot);
  } catch {
    process.exit(0);
  }

  const namespace = createHash('sha256').update(canonicalPluginRoot).digest('hex').slice(0, 12);
  const installDir = join(homedir(), '.claude', 'coral', 'installations', namespace);

  const backendBin = join(pluginRoot, 'bridge', 'coral-backend.cjs');
  let stderr = 'ignore';
  try {
    mkdirSync(installDir, { recursive: true });
    stderr = openSync(join(installDir, 'backend.log'), 'a');
  } catch {}
  const child = spawn(process.execPath, [backendBin], {
    detached: true,
    stdio: ['ignore', 'ignore', stderr],
  });
  child.unref();
} catch {}
