#!/usr/bin/env node
import { readFileSync, copyFileSync, readdirSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { buildFlavor, claudeConfigDir, exitIfChildProcess, exitIfWrongFlavor, readStdin } from './lib/hook-utils.mjs';
exitIfChildProcess();
exitIfWrongFlavor();

function fileHash(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

const PRESERVE = new Set(['.coral-codex-enabled']);

function cleanRuntimeFiles(hudDir) {
  let entries;
  try { entries = readdirSync(hudDir); } catch { return; }
  for (const name of entries) {
    if (name.startsWith('.coral-') && !PRESERVE.has(name)) {
      try { unlinkSync(join(hudDir, name)); } catch {}
    }
  }
}

try {
  await readStdin();

  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  if (!pluginRoot) process.exit(0);
  if (buildFlavor() !== 'prod') process.exit(0);

  const hudDir = join(claudeConfigDir(), 'hud');
  const installed = join(hudDir, 'coral-hud.mjs');
  const source = join(pluginRoot, 'skills', 'statusline', 'coral-hud.mjs');

  let currentHash;
  try { currentHash = fileHash(installed); } catch { process.exit(0); }

  if (currentHash === fileHash(source)) process.exit(0);

  cleanRuntimeFiles(hudDir);
  copyFileSync(source, installed);
} catch {
  process.exit(0);
}
