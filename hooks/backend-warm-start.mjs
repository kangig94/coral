#!/usr/bin/env node
import { mkdirSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { exitIfChildProcess, exitIfWrongFlavor, parseManifestFlavor, readStdin } from './lib/hook-utils.mjs';

const BACKEND_HOOK_TIMEOUT_MS = 1000;

function readManifestFlavor(pluginRoot) {
  return parseManifestFlavor(join(pluginRoot, 'bridge', 'manifest.json')) ?? 'prod';
}

function recordFlavor(record) {
  return record?.flavor === 'dev' ? 'dev' : 'prod';
}

function hasLivePid(record) {
  if (!record || typeof record.pid !== 'number' || record.pid <= 0) return false;
  try {
    process.kill(record.pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readLiveBackendFlavor(info) {
  if (!info || typeof info.host !== 'string' || typeof info.port !== 'number' || typeof info.token !== 'string') {
    return null;
  }

  try {
    const response = await fetch(`http://${info.host}:${info.port}/health`, {
      method: 'GET',
      headers: { 'X-Coral-Coordinator-Token': info.token },
      signal: AbortSignal.timeout(BACKEND_HOOK_TIMEOUT_MS),
    });
    if (!response.ok) return null;

    const body = await response.json();
    return body?.flavor === 'dev' ? 'dev' : body?.flavor === 'prod' ? 'prod' : null;
  } catch {
    return null;
  }
}

async function requestBackendShutdown(info) {
  if (!info || typeof info.host !== 'string' || typeof info.port !== 'number' || typeof info.token !== 'string') {
    return;
  }

  try {
    await fetch(`http://${info.host}:${info.port}/admin/shutdown`, {
      method: 'POST',
      headers: { 'X-Coral-Coordinator-Token': info.token },
      signal: AbortSignal.timeout(BACKEND_HOOK_TIMEOUT_MS),
    });
  } catch {}
}

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

  const expectedFlavor = readManifestFlavor(canonicalPluginRoot);
  const namespace = createHash('sha256').update(canonicalPluginRoot).digest('hex').slice(0, 12);
  const installDir = join(homedir(), '.claude', 'coral', 'installations', namespace);

  // Skip only when the live backend already matches this build flavor.
  // Wrong-flavor daemons must be shut down so replacement can proceed.
  try {
    const info = JSON.parse(readFileSync(join(installDir, 'backend.json'), 'utf-8'));
    if (hasLivePid(info)) {
      const liveFlavor = await readLiveBackendFlavor(info);
      if (liveFlavor === expectedFlavor) {
        process.exit(0);
      }
      if (liveFlavor !== null) {
        await requestBackendShutdown(info);
      }
    }
  } catch {}

  // Skip only when a same-flavor backend start is already in flight.
  try {
    const lock = JSON.parse(readFileSync(join(installDir, 'backend.lock'), 'utf-8'));
    if (hasLivePid(lock) && recordFlavor(lock) === expectedFlavor) {
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
