#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';

try {
  const input = JSON.parse(await readStdin());
  const sessionId = input.session_id;
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;

  if (!pluginRoot || !existsSync(pluginRoot)) process.exit(0);

  const claudeMdContent = readFileSync(`${pluginRoot}/CLAUDE.md`, 'utf-8');
  const additionalContext = sessionId
    ? `SessionStart:session_id=${sessionId}\n\n${claudeMdContent}`
    : claudeMdContent;

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
