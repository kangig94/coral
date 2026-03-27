#!/usr/bin/env node
import { mkdirSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { exitIfChildProcess, readStdin } from './lib/hook-utils.mjs';
exitIfChildProcess();

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

  // Skip if backend already running (backend.json with live pid)
  try {
    const info = JSON.parse(readFileSync(join(installDir, 'backend.json'), 'utf-8'));
    if (info && typeof info.pid === 'number' && info.pid > 0) {
      process.kill(info.pid, 0);
      process.exit(0);
    }
  } catch {}

  // Skip if another process is already starting a backend (lock with live pid)
  try {
    const lock = JSON.parse(readFileSync(join(installDir, 'backend.lock'), 'utf-8'));
    if (lock && typeof lock.pid === 'number' && lock.pid > 0) {
      process.kill(lock.pid, 0);
      process.exit(0);
    }
  } catch {}

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
