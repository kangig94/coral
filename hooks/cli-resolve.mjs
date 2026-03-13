#!/usr/bin/env node

import { join } from 'node:path';

// Fail-open: any error -> silent exit 0
try {
  const input = JSON.parse(await readStdin());

  // Only handle Bash PreToolUse
  if (input.hook_event_name !== 'PreToolUse' || input.tool_name !== 'Bash') {
    process.exit(0);
  }

  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  if (!pluginRoot) process.exit(0);

  const command = input.tool_input?.command;
  if (typeof command !== 'string') process.exit(0);

  // Match ONLY when the first executable token (after optional leading whitespace)
  // is the bare, unquoted word "coral-cli" followed by whitespace or end-of-string.
  // Do NOT match: "coral-cli" (quoted), 'coral-cli' (quoted), env=val coral-cli,
  // bash -c '...coral-cli...', or coral-cli appearing later in pipeline.
  const match = command.match(/^(\s*)coral-cli(\s|$)(.*)/s);
  if (!match) process.exit(0);

  const cliPath = join(pluginRoot, 'bridge', 'coral-cli.cjs');
  const rewritten = `${match[1]}node "${cliPath}"${match[2]}${match[3]}`;

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      updatedInput: {
        tool_input: {
          command: rewritten,
        },
      },
    },
  }));
} catch {
  process.exit(0);
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve('{}'));
  });
}
