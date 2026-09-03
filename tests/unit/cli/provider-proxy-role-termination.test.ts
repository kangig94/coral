import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerBackendCommands } from '#src/cli/commands/backend.js';
import {
  createProviderProxyRoleTerminationCommandOperations,
  type ProviderProxyRoleTerminationCommandOperations,
} from '#src/cli/commands/provider-proxy-role-termination.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

async function runTerminateRole(
  operations: ProviderProxyRoleTerminationCommandOperations,
  incarnation = testIncarnation(6101),
): Promise<Readonly<{ stdout: string; stderr: string }>> {
  let stdout = '';
  let stderr = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr += String(chunk);
    return true;
  });
  const program = new Command();
  program.exitOverride();
  registerBackendCommands(program, { providerProxyRoleTermination: operations });
  await program.parseAsync([
    'node',
    'coral-cli',
    'backend',
    'provider-proxy-set',
    'terminate-role',
    '--role',
    'reaper',
    '--pid',
    '6101',
    '--incarnation',
    incarnation,
  ]);
  return { stdout, stderr };
}

describe('backend provider-proxy-set terminate-role', () => {
  it('refuses a pid whose observed incarnation differs from the recorded role identity', async () => {
    const signal = vi.fn();
    const observedIncarnation = testIncarnation(7101);
    const operations = createProviderProxyRoleTerminationCommandOperations({
      platform: 'linux',
      readProcessIncarnation: () => observedIncarnation,
      signal,
    });

    const output = await runTerminateRole(operations);

    expect(signal).not.toHaveBeenCalled();
    expect(output.stdout).toBe('');
    expect(output.stderr).toContain(`observed incarnation "${observedIncarnation}" does not match`);
    expect(output.stderr).toContain('No signal was sent.');
    expect(process.exitCode).toBe(1);
  });

  it('refuses when the target incarnation cannot be observed', async () => {
    const signal = vi.fn();
    const operations = createProviderProxyRoleTerminationCommandOperations({
      platform: 'linux',
      readProcessIncarnation: () => null,
      signal,
    });

    const output = await runTerminateRole(operations);

    expect(signal).not.toHaveBeenCalled();
    expect(output.stdout).toBe('');
    expect(output.stderr).toContain('current incarnation could not be observed');
    expect(process.exitCode).toBe(75);
  });

  it('signals only after the observed incarnation matches the full recorded identity', async () => {
    const incarnation = testIncarnation(6101);
    const signal = vi.fn();
    const operations = createProviderProxyRoleTerminationCommandOperations({
      platform: 'linux',
      readProcessIncarnation: () => incarnation,
      signal,
    });

    const output = await runTerminateRole(operations, incarnation);

    expect(signal).toHaveBeenCalledOnce();
    expect(signal).toHaveBeenCalledWith(6101, 'SIGTERM');
    expect(output.stderr).toBe('');
    expect(output.stdout).toContain('Sent SIGTERM to reaper role pid 6101');
    expect(process.exitCode).toBe(0);
  });
});
