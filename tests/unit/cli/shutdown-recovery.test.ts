import { Command } from 'commander';
import { describe, expect, it } from 'vitest';

import { registerBackendCommands } from '#src/cli/commands/backend.js';

function findCommand(root: Command, ...path: string[]): Command {
  let current = root;
  for (const name of path) {
    const next = current.commands.find((command) => command.name() === name);
    if (next === undefined) throw new Error(`Missing command: ${path.join(' ')}`);
    current = next;
  }
  return current;
}

describe('backend shutdown-recovery abandon CLI text', () => {
  it('does not promise an outcome this coordinator cannot produce', () => {
    const program = new Command();
    registerBackendCommands(program);
    const abandon = findCommand(program, 'backend', 'shutdown-recovery', 'abandon');

    // abandonShutdownObligation (src/coordinator/lifecycle.ts) answers only 'not-held' or 'not-offered'
    // on this build, so the command description and argument hint must not claim it can durably abandon
    // an obligation here, or that a held shutdown currently offers one.
    expect(abandon.description()).toBe(
      'Abandon one exact obligation a held shutdown offered on an older coordinator; this coordinator offers none, so the attempt is refused',
    );
    expect(abandon.description()).not.toContain('Durably abandon');

    const [subjectArgument] = abandon.registeredArguments;
    expect(subjectArgument?.description).toBe(
      'Exact subject a held shutdown offered on an older coordinator; this coordinator offers none, so any value is refused',
    );
    // The old hint enumerated the subject set as if one of them were currently reachable; the parse
    // error (a separate, unaffected path) is still where that closed set is listed.
    expect(subjectArgument?.description).not.toContain('One of:');
  });
});
