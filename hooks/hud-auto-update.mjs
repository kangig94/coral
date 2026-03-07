#!/usr/bin/env node
import { readFileSync, copyFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';

function fileHash(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

try {
  let data = '';
  await new Promise((resolve) => {
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', resolve);
    process.stdin.on('error', resolve);
  });

  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  if (!pluginRoot) process.exit(0);

  const installed = join(homedir(), '.claude', 'hud', 'coral-hud.mjs');
  const source = join(pluginRoot, 'skills', 'statusline', 'coral-hud.mjs');

  let currentHash;
  try { currentHash = fileHash(installed); } catch { process.exit(0); }

  if (currentHash === fileHash(source)) process.exit(0);

  copyFileSync(source, installed);
} catch {}
