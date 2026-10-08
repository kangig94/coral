import type * as DispatchMod from '#src/cli/dispatch.js';
import { Command } from 'commander';
import { afterEach, expect, it, vi } from 'vitest';
import { registerProviderCommands } from '#src/cli/commands/provider.js';
import { registerWorkflowCommands } from '#src/cli/commands/workflow.js';
import { registerKbCommands } from '#src/cli/commands/kb.js';
import { createBuiltInProviderRegistry } from '#src/providers/bootstrap.js';

const memoWrite = vi.hoisted(() => vi.fn(async () => ({ filename: 'memo.md' })));
vi.mock('#src/cli/dispatch.js', async (importOriginal) => ({
  ...(await importOriginal<typeof DispatchMod>()),
  makeClient: () => ({ kbMemo: memoWrite }),
}));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  memoWrite.mockClear();
  process.exitCode = undefined;
});

it('session job guard: memo write chooses the environment owner before validating a legacy flag', async () => {
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  for (const envOwner of ['session-env', undefined]) {
    vi.stubEnv('CORAL_OWNER', envOwner);
    const program = new Command();
    registerKbCommands(program);
    await program.parseAsync(
      ['kb', 'memo', 'write', '--topic', 'sample', '--content', 'body', '--owner', 'legacy-session'],
      { from: 'user' },
    );
    expect(memoWrite).toHaveBeenLastCalledWith({
      topic: 'sample',
      content: 'body',
      owner: envOwner ?? 'legacy-session',
    });
  }
});

it('session job guard: accepts legacy owner flags while hiding them from every command help', () => {
  const program = new Command();
  registerProviderCommands(program, createBuiltInProviderRegistry());
  registerWorkflowCommands(program);
  registerKbCommands(program);
  const memo = program.commands.find((c) => c.name() === 'kb')!.commands.find((c) => c.name() === 'memo')!;
  const commands = [...program.commands.filter((c) => c.name() !== 'kb'), ...memo.commands];
  for (const command of commands) {
    expect(command.helpInformation()).not.toContain('--owner');
    expect(command.helpInformation()).not.toContain('-o,');
    for (const flag of ['--owner', '-o']) {
      expect(command.parseOptions([flag, 'legacy-session']).unknown).toEqual([]);
      expect(command.opts().owner).toBe('legacy-session');
    }
  }
});
