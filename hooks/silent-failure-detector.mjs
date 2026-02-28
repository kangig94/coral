#!/usr/bin/env node

/**
 * PostToolUse hook — detects silent command failures in tool output.
 * Fail-open: any error exits silently.
 */

import { readdirSync } from 'node:fs';
import { join } from 'node:path';

try {
  const input = JSON.parse(await readStdin());
  const cmd = String(input.tool_input?.command ?? '');
  if (!/\|\s*tee\b|\|\|\s*(true|:)\b/.test(cmd)) process.exit(0);

  const stdout = String(input.tool_response?.stdout ?? '');
  const stderr = String(input.tool_response?.stderr ?? '');
  const combinedOutput = `${stdout}\n${stderr}`;
  const failurePattern = /Failed to build|BUILD FAILED|Traceback \(most recent call last\)|npm ERR!|^error\[E\d+\]/m;

  if (!failurePattern.test(combinedOutput)) process.exit(0);

  const projectDir = process.env.CLAUDE_PROJECT_DIR || '.';
  const kbDir = join(projectDir, '.claude', 'coral', 'kb');
  const files = readdirSync(kbDir).filter(f => f.endsWith('.md'));
  if (files.length === 0) process.exit(0);

  const topics = [...new Set(files.map(f => f.replace(/\.md$/, '').replace(/-.*$/, '')))].sort();
  if (topics.length === 0) process.exit(0);

  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: `Silent failure detected in command output. Before debugging from scratch, check .claude/coral/kb/ for relevant knowledge. KB topics: ${topics.join(', ')}`,
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
