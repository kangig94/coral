#!/usr/bin/env node
//
// PreToolUse:Monitor hook — wraps the Monitor tool's command so the streamed
// process records its own lifecycle in the live-work registry (see
// lib/live-work-registry.mjs beginBgTask). A Monitor runs its command in the
// background, so a bounded Monitor is tracked exactly like a backgrounded Bash
// command and the Stop hooks (ralph-loop, kb-promote-gate) defer while it is live.
//
// NOT wrapped:
//   - the `ws` variant (WebSocket monitor) — no shell command to wrap;
//   - `persistent` monitors (session-length watchers like a log tail) — tracking
//     one would keep hasLiveWork true for the whole session and stall the ralph
//     loop indefinitely, so they are deliberately left untracked.
//
// The injected wrapper is silent (no stdout), so it never pollutes the Monitor's
// line-oriented event stream.

import { exitIfChildProcess, exitIfWrongFlavor, readStdin, writeHookOutput } from './lib/hook-utils.mjs';
import { projectDirFromInput } from './lib/plugin-paths.mjs';
import { beginBgTask } from './lib/live-work-registry.mjs';
exitIfChildProcess();
exitIfWrongFlavor();

try {
  const input = JSON.parse(await readStdin());

  if (input.hook_event_name !== 'PreToolUse') process.exit(0);
  if (input.tool_name !== 'Monitor') process.exit(0);
  if (input.tool_input?.persistent === true) process.exit(0);

  const command = input.tool_input?.command;
  if (typeof command !== 'string') process.exit(0); // ws-variant monitors have no command

  const bg = beginBgTask(projectDirFromInput(input), input.session_id);
  if (!bg) process.exit(0); // invalid session / I/O error ⇒ leave the command unwrapped

  writeHookOutput({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: 'monitor lifecycle tracking',
      updatedInput: { ...input.tool_input, command: `${bg.wrapper}\n${command}` },
    },
  });
} catch {
  process.exit(0);
}
