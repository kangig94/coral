import { afterEach, describe, expect, it, vi } from 'vitest';

import { installErrorSchema } from '#src/expansion/rpc-contract.js';

function toText(chunk: string | Uint8Array): string {
  return typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
}

// Each case re-imports `bootstrap.ts` after `vi.resetModules()` (it runs on load) and deliberately uses the
// real `buildProgram()`, so the first case absorbs a cold transform+resolve of the whole CLI command graph
// (~1.2s idle). `vitest/default.ts` oversubscribes workers on CI (4 workers on a 2-core runner) by design, so
// that inflates under contention past the 5s default. Budget for the import; a genuine hang still trips this.
describe('expansion bootstrap output', { timeout: 30_000 }, () => {
  const originalArgv = [...process.argv];
  let stdout = '';
  let stderr = '';

  async function runBootstrap(argv: string[]): Promise<void> {
    stdout = '';
    stderr = '';
    process.argv = ['node', 'coral-cli', ...argv];
    process.exitCode = undefined;

    vi.resetModules();
    vi.spyOn(process, 'exit').mockImplementation(((_code?: number) => undefined) as typeof process.exit);
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      stdout += toText(chunk);
      return true;
    }) as typeof process.stdout.write);
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      stderr += toText(chunk);
      return true;
    }) as typeof process.stderr.write);

    const { bootstrapCompletion } = await import('#src/cli/bootstrap.js');
    await bootstrapCompletion;
  }

  afterEach(() => {
    process.argv = [...originalArgv];
    process.exitCode = undefined;
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('keeps expansion --help visible on stdout with exit 0', async () => {
    await runBootstrap(['expansion', '--help']);

    expect(stderr).toBe('');
    expect(stdout.trim().length).toBeGreaterThan(0);
    expect(stdout).toContain('Usage: coral-cli expansion');
    expect(stdout).toContain('Manage expansion packages');
    expect(process.exit).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(0);
  });

  it('normalizes expansion equip missing-argument failures to one stdout InstallError JSON line', async () => {
    await runBootstrap(['expansion', 'equip']);

    expect(stderr).toBe('');
    expect(stdout.endsWith('\n')).toBe(true);
    expect(stdout.trim().split('\n')).toHaveLength(1);
    const parsed = installErrorSchema.parse(JSON.parse(stdout));
    expect(parsed.code).toBe('invalid_usage');
    expect(process.exit).toHaveBeenCalledWith(2);
  });
});
