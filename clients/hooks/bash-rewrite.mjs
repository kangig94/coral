#!/usr/bin/env node
//
// PreToolUse:Bash hook — the single owner of Bash command rewriting. Two jobs:
//   - put the active plugin's bridge directory on PATH for commands that run
//     coral-cli (+ wait foreground timeout)
//   - wrap `run_in_background` commands so they record their own lifecycle in the
//     live-work registry (lib/live-work-registry.mjs beginBgTask), giving Stop
//     hooks a way to tell whether backgrounded work is still running.
//
// The command text is prefixed, never parsed or edited: every shell reads it
// exactly as written.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exitIfChildProcess, exitIfWrongFlavor, readStdin, writeHookOutput } from './lib/hook-utils.mjs';
import { projectDirFromInput } from './lib/plugin-paths.mjs';
import { beginBgTask } from './lib/live-work-registry.mjs';
import { textInvokesCoralCli, textInvokesCoralWait } from './lib/coral-invocation.mjs';
exitIfChildProcess();
exitIfWrongFlavor();

const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BRIDGE_DIR = join(PLUGIN_ROOT, 'bridge');

// Bash rejects timeouts above 600_000 ms, so this is the ceiling, not a choice. A bounded wait derives its
// own deadline from this value minus a flush margin (see FOLLOW_TIMEOUT_SECONDS in src/cli/follow.ts) so it
// finishes first: it exits 75 with a printed resume command when work is still running. The command has a
// cursor after observed progress, but can be cursor-free when initial backend recovery/shutdown retries
// exhaust; the command and exit code would both be lost if Bash killed the process mid-write.
const WAIT_BASH_TIMEOUT_MS = 600_000;

function singleQuoted(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

// The active plugin's bridge goes first so it shadows any other coral-cli on PATH.
const PATH_PREFIX = `export PATH=${singleQuoted(BRIDGE_DIR)}:"$PATH"`;

// === Main I/O (fail-open) ===

try {
  const input = JSON.parse(await readStdin());

  if (input.hook_event_name !== 'PreToolUse' || input.tool_name !== 'Bash') {
    process.exit(0);
  }

  const command = input.tool_input?.command;
  if (typeof command !== 'string') process.exit(0);

  const updatedInput = { ...input.tool_input };
  const invokesCoralCli = textInvokesCoralCli(command);
  let nextCommand = invokesCoralCli ? `${PATH_PREFIX}\n${command}` : command;
  let changed = invokesCoralCli;

  // A foreground wait blocks until just under the ceiling, so it gets the whole ceiling. run_in_background is
  // left to the caller; a backgrounded wait is tracked like any other background command below.
  if (textInvokesCoralWait(command)) {
    updatedInput.timeout = WAIT_BASH_TIMEOUT_MS;
  }

  // Wrap any command that will actually run in the background so it records its
  // own start/liveness/exit in the live-work registry. Best-effort: beginBgTask
  // returns null (⇒ command left unwrapped) on invalid session or I/O error.
  if (updatedInput.run_in_background === true) {
    const bg = beginBgTask(projectDirFromInput(input), input.session_id);
    if (bg) {
      nextCommand = `${bg.wrapper}\n${nextCommand}`;
      changed = true;
    }
  }

  if (!changed) process.exit(0);
  updatedInput.command = nextCommand;

  writeHookOutput({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: 'bash auto-rewrite',
      updatedInput,
    },
  });
} catch {
  process.exit(0);
}
