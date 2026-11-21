#!/usr/bin/env node
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exitIfChildProcess, exitIfWrongFlavor, readStdin, writeHookOutput } from './lib/hook-utils.mjs';
import { projectDirFromInput } from './lib/plugin-paths.mjs';
import { beginBgTask, recordCoralWait } from './lib/live-work-registry.mjs';
import { isCoralOnlyCommand, textInvokesCoralCli, textInvokesCoralWait } from './lib/coral-invocation.mjs';
exitIfChildProcess();
exitIfWrongFlavor();

const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BRIDGE_DIR = join(PLUGIN_ROOT, 'bridge');

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
  const autoApprove = isCoralOnlyCommand(command);
  // Codex rejects updatedInput without allow; mixed commands must retain normal permission checks.
  if (process.argv.includes('--codex-requires-allow') && !autoApprove) process.exit(0);

  const updatedInput = { ...input.tool_input };
  const invokesCoralCli = textInvokesCoralCli(command);
  const ownerPrefix = typeof input.session_id === 'string' && input.session_id.length > 0
    ? `; CORAL_OWNER=\${CORAL_OWNER-${singleQuoted(input.session_id)}}; export CORAL_OWNER`
    : '';
  let nextCommand = invokesCoralCli ? `${PATH_PREFIX}${ownerPrefix}\n${command}` : command;
  let changed = invokesCoralCli;

  if (textInvokesCoralWait(command)) {
    try {
      recordCoralWait(projectDirFromInput(input), input.session_id);
    } catch {}
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
      ...(autoApprove ? {
        permissionDecision: 'allow',
        permissionDecisionReason: 'bash auto-rewrite',
      } : {}),
      updatedInput,
    },
  });
} catch {
  process.exit(0);
}
