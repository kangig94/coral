#!/usr/bin/env node

import { existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

try {
  const input = JSON.parse(await readStdin());
  const sessionId = input.session_id;
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;

  if (!pluginRoot || !existsSync(pluginRoot)) process.exit(0);

  // Ensure .claude/coral → $CORAL_DATA symlink for IDE browsing
  const projectDir = process.env.CLAUDE_PROJECT_DIR;
  const pluginData = process.env.CLAUDE_PLUGIN_DATA || join(process.env.HOME || '', '.claude', 'plugins', 'data', 'coral-coral');
  if (projectDir && pluginData) {
    const projectSlug = projectDir.replace(/\//g, '-');
    const dataDir = join(pluginData, 'projects', projectSlug);
    const link = join(projectDir, '.claude', 'coral');
    try {
      mkdirSync(dataDir, { recursive: true });
      // Replace stale symlink or skip if real dir
      if (existsSync(link)) {
        try { if (lstatSync(link).isSymbolicLink()) unlinkSync(link); } catch {}
      }
      if (!existsSync(link)) symlinkSync(dataDir, link);
    } catch { /* fail-open */ }
  }

  const claudeMdContent = readFileSync(`${pluginRoot}/CLAUDE.md`, 'utf-8');
  const coralDataLine = projectDir && pluginData
    ? `CORAL_DATA=${join(pluginData, 'projects', projectDir.replace(/\//g, '-'))}`
    : '';
  const additionalContext = sessionId
    ? `SessionStart:session_id=${sessionId}\n${coralDataLine}\n\n${claudeMdContent}`
    : `${coralDataLine}\n\n${claudeMdContent}`;

  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext,
    },
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
