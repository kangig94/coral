#!/usr/bin/env node
//
// PreToolUse:Monitor hook — denies `coral-cli wait` from the Monitor tool.
// Monitor is for streaming event sources (log tails, file watchers);
// `coral-cli wait` is a one-shot blocking wait whose lines are progress
// output, not discrete events. It belongs on the Bash tool, where
// cli-resolve already injects the extended timeout and forces foreground.

import { exitIfChildProcess, exitIfWrongFlavor, readStdin } from './lib/hook-utils.mjs';
import { commandHasCoralWait } from './lib/coral-invocation.mjs';
exitIfChildProcess();
exitIfWrongFlavor();

const DENY_REASON = 'coral-cli wait must run via the Bash tool, not Monitor. '
  + 'Monitor streams lines as discrete events — wait is a one-shot blocking call. '
  + 'The cli-resolve hook automatically extends the Bash timeout and forces foreground for coral-cli wait.';

try {
  const input = JSON.parse(await readStdin());

  if (input.hook_event_name !== 'PreToolUse') process.exit(0);
  if (input.tool_name !== 'Monitor') process.exit(0);

  const command = input.tool_input?.command;
  if (typeof command !== 'string') process.exit(0);

  if (!commandHasCoralWait(command)) process.exit(0);

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: DENY_REASON,
    },
  }) + '\n');
} catch {
  process.exit(0);
}
