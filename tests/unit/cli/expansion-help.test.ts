import { afterEach, describe, expect, it, vi } from 'vitest';

import { runCli } from '#src/cli/run.js';
import { installErrorSchema } from '#src/expansion/rpc-contract.js';

function toText(chunk: string | Uint8Array): string {
  return typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
}

// Static import of `runCli`, invoked per case. Re-importing a self-executing entry through
// `vi.resetModules()` used to charge this file's cold transform of the real command graph to whichever case
// ran first, which flaked against the 5s default; collection absorbs it now.
describe('expansion bootstrap output', () => {
  const originalArgv = [...process.argv];
  let stdout = '';
  let stderr = '';

  async function run(argv: string[]): Promise<void> {
    stdout = '';
    stderr = '';
    process.argv = ['node', 'coral-cli', ...argv];
    process.exitCode = undefined;

    vi.spyOn(process, 'exit').mockImplementation(((_code?: number) => undefined) as typeof process.exit);
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      stdout += toText(chunk);
      return true;
    }) as typeof process.stdout.write);
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      stderr += toText(chunk);
      return true;
    }) as typeof process.stderr.write);

    await runCli();
  }

  afterEach(() => {
    process.argv = [...originalArgv];
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it('keeps expansion --help visible on stdout with exit 0', async () => {
    await run(['expansion', '--help']);

    expect(stderr).toBe('');
    expect(stdout.trim().length).toBeGreaterThan(0);
    expect(stdout).toContain('Usage: coral-cli expansion');
    expect(stdout).toContain('Manage expansion packages');
    expect(process.exit).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(0);
  });

  it('normalizes expansion equip missing-argument failures to one stdout InstallError JSON line', async () => {
    await run(['expansion', 'equip']);

    expect(stderr).toBe('');
    expect(stdout.endsWith('\n')).toBe(true);
    expect(stdout.trim().split('\n')).toHaveLength(1);
    const parsed = installErrorSchema.parse(JSON.parse(stdout));
    expect(parsed.code).toBe('invalid_usage');
    expect(process.exit).toHaveBeenCalledWith(2);
  });
});
