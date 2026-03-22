#!/usr/bin/env node

/**
 * PostToolUseFailure + PostToolUse(Bash) hook — reminds Claude to check ~/.coral/kb/notes/ on errors.
 * - PostToolUseFailure: any tool failure → KB reminder
 * - PostToolUse(Bash): silent failures (exit 0 but error in output) → KB reminder
 * Fail-open: any error exits silently.
 */

import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const MASKING_RE = /\|\s*tee\b|\|\|\s*(true|:)\b/;
const FAILURE_RE = /Failed to build|BUILD FAILED|Traceback \(most recent call last\)|npm ERR!|^error\[E\d+\]/m;

try {
  const input = JSON.parse(await readStdin());
  const event = input.hook_event_name;

  // PostToolUse(Bash): only fire for masked commands with failure output
  if (event === 'PostToolUse') {
    const cmd = String(input.tool_input?.command ?? '');
    if (!MASKING_RE.test(cmd)) process.exit(0);
    const output = `${input.tool_response?.stdout ?? ''}\n${input.tool_response?.stderr ?? ''}`;
    if (!FAILURE_RE.test(output)) process.exit(0);
  }

  const kbRoot = resolveKbRoot();
  const kbNotesDir = join(kbRoot, 'notes');
  const files = readdirSync(kbNotesDir).filter(f => f.endsWith('.md'));
  if (files.length === 0) process.exit(0);

  const topics = [...new Set(files.map(f => f.replace(/\.md$/, '').replace(/-.*$/, '')))].sort();
  const prefix = event === 'PostToolUse' ? 'Silent failure detected in command output' : 'Error detected';

  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: event,
      additionalContext: `${prefix}. Before debugging from scratch, check ${kbRoot}/notes/ for relevant knowledge. KB topics: ${topics.join(', ')}`,
    },
  }));
} catch {
  process.exit(0);
}

function resolveKbRoot() {
  const custom = process.env.CORAL_KB_PATH;
  if (custom) return custom.startsWith('~') ? join(homedir(), custom.slice(1)) : custom;
  return join(homedir(), '.coral', 'kb');
}

function readStdin() {
  return new Promise(resolve => {
    let data = '';
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve('{}'));
  });
}
