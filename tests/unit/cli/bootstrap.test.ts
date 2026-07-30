import { CommanderError } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const parseAsync = vi.hoisted(() => vi.fn());
const emitError = vi.hoisted(() => vi.fn());

vi.mock('#src/cli/program.js', () => ({
  buildProgram: () => ({ parseAsync }),
}));
vi.mock('#src/cli/emit.js', () => ({ emitError }));

// Static import: `runCli` is invoked per case, so no case needs `vi.resetModules()` plus a re-import to get a
// fresh run. That keeps the command graph's cold transform in this file's collection phase instead of
// charging it to whichever case imports first, which is what made these cases flake against the 5s default.
import { runCli } from '#src/cli/run.js';

describe('cli bootstrap', () => {
  const originalArgv = [...process.argv];

  beforeEach(() => {
    vi.spyOn(process, 'exit').mockImplementation(((_code?: number) => undefined) as typeof process.exit);
  });

  afterEach(() => {
    process.argv = [...originalArgv];
    vi.restoreAllMocks();
    parseAsync.mockReset();
    emitError.mockReset();
    process.exitCode = undefined;
  });

  it('exits 0 for --help CommanderError without emitting an envelope', async () => {
    process.argv = ['node', 'coral-cli', '--help'];
    parseAsync.mockRejectedValue(new CommanderError(0, 'commander.helpDisplayed', '(outputHelp)'));

    await runCli();

    expect(parseAsync).toHaveBeenCalledWith(process.argv);
    expect(process.exit).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(0);
    expect(emitError).not.toHaveBeenCalled();
  });

  it('exits 0 for --version CommanderError without emitting an envelope', async () => {
    process.argv = ['node', 'coral-cli', '--version'];
    parseAsync.mockRejectedValue(new CommanderError(0, 'commander.version', '1.2.3'));

    await runCli();

    expect(parseAsync).toHaveBeenCalledWith(process.argv);
    expect(process.exit).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(0);
    expect(emitError).not.toHaveBeenCalled();
  });

  it('routes non-zero CommanderError through emitError and preserves exit 2', async () => {
    process.argv = ['node', 'coral-cli', 'wait'];
    parseAsync.mockRejectedValue(
      new CommanderError(2, 'commander.missingArgument', "error: missing required argument 'jobIds'"),
    );
    emitError.mockImplementation((_error: unknown) => {
      // Simulate real emitError setting exit code for CommanderError → 2.
      process.exitCode = 2;
    });

    await runCli();

    expect(parseAsync).toHaveBeenCalledWith(process.argv);
    expect(emitError).toHaveBeenCalledTimes(1);
    const [error] = emitError.mock.calls[0] ?? [];
    expect(error).toBeInstanceOf(Error);
    expect(process.exit).toHaveBeenCalledWith(2);
  });
});
