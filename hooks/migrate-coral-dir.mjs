#!/usr/bin/env node

/**
 * Stop hook — migrates .claude/coral/ data (one-time).
 * - .claude/coral/kb/ → .kb/ (project root, git-tracked)
 * - .claude/coral/{memo,plans,analysis,discuss} → ${CLAUDE_PLUGIN_DATA}/projects/<slug>/
 * If .kb/ already exists, skips (migration already done).
 * Fail-open: any error exits silently.
 */

import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';

try {
  const input = JSON.parse((await readStdin()) || '{}');
  const projectDir = process.env.CLAUDE_PROJECT_DIR ?? input.cwd ?? '.';
  const pluginData = process.env.CLAUDE_PLUGIN_DATA || join(process.env.HOME || '', '.claude', 'plugins', 'data', 'coral-coral');
  const oldDir = join(projectDir, '.claude', 'coral');
  const kbTarget = join(projectDir, '.kb');

  // Already migrated or nothing to migrate
  if (existsSync(kbTarget)) process.exit(0);
  if (!existsSync(oldDir)) process.exit(0);

  // Migrate kb/ → .kb/
  const oldKb = join(oldDir, 'kb');
  if (existsSync(oldKb)) {
    renameSync(oldKb, kbTarget);
  }

  // Migrate memo, plans, analysis, discuss → plugin data
  const projectSlug = projectDir.replace(/\//g, '-');
  const dataDir = join(pluginData, 'projects', projectSlug);
  for (const sub of ['memo', 'plans', 'analysis', 'discuss']) {
    const src = join(oldDir, sub);
    if (!existsSync(src)) continue;
    const dest = join(dataDir, sub);
    mkdirSync(dest, { recursive: true });
    cpSync(src, dest, { recursive: true });
    rmSync(src, { recursive: true, force: true });
  }

  // Clean up empty .claude/coral/ if possible
  try {
    const remaining = readdirSync(oldDir);
    if (remaining.length === 0) rmSync(oldDir, { recursive: true });
  } catch { /* ignore */ }

  console.log(JSON.stringify({
    decision: 'block',
    reason: 'Coral data migrated: .claude/coral/kb/ → .kb/ (git-tracked). Other data moved to plugin storage. Add .kb/ to version control and remove .claude/coral/ from .gitignore if present.',
    systemMessage: '📦 Coral: migrated .claude/coral/ → .kb/ + plugin data',
  }));
} catch {
  process.exit(0);
}

function readStdin() {
  return new Promise(resolve => {
    let data = '';
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve('{}'));
  });
}
