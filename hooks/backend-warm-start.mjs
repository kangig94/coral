#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

try {
  let data = '';
  await new Promise((resolve) => {
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', resolve);
    process.stdin.on('error', resolve);
  });

  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  if (!pluginRoot) process.exit(0);

  let canonicalPluginRoot;
  try {
    canonicalPluginRoot = realpathSync(pluginRoot);
  } catch {
    process.exit(0);
  }

  const namespace = createHash('sha256').update(canonicalPluginRoot).digest('hex').slice(0, 12);
  const infoPath = join(homedir(), '.claude', 'coral', 'installations', namespace, 'backend.json');
  try {
    const info = JSON.parse(readFileSync(infoPath, 'utf-8'));
    if (info && typeof info.pid === 'number' && info.pid > 0) {
      process.kill(info.pid, 0);
      process.exit(0);
    }
  } catch {}

  const backendBin = join(pluginRoot, 'bridge', 'coral-backend.cjs');
  const child = spawn(process.execPath, [backendBin], {
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  child.unref();
} catch {}
