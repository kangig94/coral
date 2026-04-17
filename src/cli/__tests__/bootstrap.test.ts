import { CommanderError } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('cli bootstrap', () => {
  const originalArgv = [...process.argv];

  afterEach(() => {
    process.argv = [...originalArgv];
    vi.restoreAllMocks();
    vi.resetModules();
    process.exitCode = undefined;
  });

  async function importBootstrapWith(options: {
    parseError?: unknown;
    outputFormat?: 'text' | 'json';
  }): Promise<{
    emitError: ReturnType<typeof vi.fn>;
    parseAsync: ReturnType<typeof vi.fn>;
  }> {
    const emitError = vi.fn();
    const parseAsync = options.parseError === undefined
      ? vi.fn().mockResolvedValue(undefined)
      : vi.fn().mockRejectedValue(options.parseError);
    const program = { parseAsync };

    vi.doMock('../main.js', () => ({
      buildProgram: () => program,
      emitError,
      getOutputFormat: () => options.outputFormat ?? 'json',
    }));

    vi.spyOn(process, 'exit').mockImplementation(((_code?: number) => undefined) as typeof process.exit);

    await import('../bootstrap.js');
    await Promise.resolve();
    await Promise.resolve();

    return { emitError, parseAsync };
  }

  it('exits 0 for --help CommanderError without emitting an envelope', async () => {
    process.argv = ['node', 'coral-cli', '--help'];

    const { emitError, parseAsync } = await importBootstrapWith({
      parseError: new CommanderError(0, 'commander.helpDisplayed', '(outputHelp)'),
    });

    expect(parseAsync).toHaveBeenCalledWith(process.argv);
    expect(process.exit).toHaveBeenCalledWith(0);
    expect(emitError).not.toHaveBeenCalled();
  });

  it('exits 0 for --version CommanderError without emitting an envelope', async () => {
    process.argv = ['node', 'coral-cli', '--version'];

    const { emitError, parseAsync } = await importBootstrapWith({
      parseError: new CommanderError(0, 'commander.version', '1.2.3'),
    });

    expect(parseAsync).toHaveBeenCalledWith(process.argv);
    expect(process.exit).toHaveBeenCalledWith(0);
    expect(emitError).not.toHaveBeenCalled();
  });

  it('routes non-zero CommanderError through emitError and preserves exit 2', async () => {
    process.argv = ['node', 'coral-cli', 'wait', '--timeout', 'bogus'];

    const emitError = vi.fn((_error: unknown, _outputFormat: 'text' | 'json') => {
      // Simulate real emitError setting exit code for CommanderError → 2.
      process.exitCode = 2;
    });
    const parseAsync = vi.fn().mockRejectedValue(
      new CommanderError(2, 'commander.invalidArgument', "option '--timeout <seconds>' argument 'bogus' is invalid"),
    );
    const program = { parseAsync };
    vi.doMock('../main.js', () => ({
      buildProgram: () => program,
      emitError,
      getOutputFormat: () => 'json' as const,
    }));
    vi.spyOn(process, 'exit').mockImplementation(((_code?: number) => undefined) as typeof process.exit);

    await import('../bootstrap.js');
    await Promise.resolve();
    await Promise.resolve();

    expect(parseAsync).toHaveBeenCalledWith(process.argv);
    expect(emitError).toHaveBeenCalledTimes(1);
    const [error, outputFormat] = emitError.mock.calls[0] ?? [];
    expect(error).toBeInstanceOf(Error);
    expect(outputFormat).toBe('json');
    expect(process.exit).toHaveBeenCalledWith(2);
  });
});
