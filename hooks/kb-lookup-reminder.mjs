#!/usr/bin/env node

/**
 * PostToolUseFailure hook — reminds Claude to check .claude/coral/kb/ on errors.
 * Fail-open: any error exits silently.
 */

import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const projectDir = process.env.CLAUDE_PROJECT_DIR || '.';
const kbDir = join(projectDir, '.claude', 'coral', 'kb');

try {
  const files = readdirSync(kbDir).filter(f => f.endsWith('.md'));
  if (files.length === 0) process.exit(0);

  const topics = [...new Set(files.map(f => f.replace(/\.md$/, '').replace(/-.*$/, '')))].sort();

  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PostToolUseFailure',
      additionalContext: `Error detected. Before debugging from scratch, check .claude/coral/kb/ for relevant knowledge. KB topics: ${topics.join(', ')}`,
    },
  }));
} catch {
  process.exit(0);
}
