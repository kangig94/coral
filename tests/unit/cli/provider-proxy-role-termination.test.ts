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
  action: 'terminate-role' | 'retry-role-reap' = 'terminate-role',
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
    action,
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
    const abandon = vi.fn(async () => ({ kind: 'abandoned' as const }));
    const observedIncarnation = testIncarnation(7101);
    const operations = createProviderProxyRoleTerminationCommandOperations({
      platform: 'linux',
      readProcessIncarnation: () => observedIncarnation,
      abandon,
      retryReap: async () => ({ kind: 'reap-retry-requested' }),
    });

    const output = await runTerminateRole(operations);

    expect(abandon).not.toHaveBeenCalled();
    expect(output.stdout).toBe('');
    expect(output.stderr).toContain(`observed incarnation "${observedIncarnation}" does not match`);
    expect(output.stderr).toContain('This command does not send process signals.');
    expect(process.exitCode).toBe(1);
  });

  it('refuses when the target incarnation cannot be observed', async () => {
    const abandon = vi.fn(async () => ({ kind: 'abandoned' as const }));
    const operations = createProviderProxyRoleTerminationCommandOperations({
      platform: 'linux',
      readProcessIncarnation: () => null,
      abandon,
      retryReap: async () => ({ kind: 'reap-retry-requested' }),
    });

    const output = await runTerminateRole(operations);

    expect(abandon).not.toHaveBeenCalled();
    expect(output.stdout).toBe('');
    expect(output.stderr).toContain('current incarnation could not be observed');
    expect(process.exitCode).toBe(75);
  });

  it('requests authenticated abandonment only after the observed incarnation matches', async () => {
    const incarnation = testIncarnation(6101);
    const abandon = vi.fn(async () => ({ kind: 'abandoned' as const }));
    const operations = createProviderProxyRoleTerminationCommandOperations({
      platform: 'linux',
      readProcessIncarnation: () => incarnation,
      abandon,
      retryReap: async () => ({ kind: 'reap-retry-requested' }),
    });

    const output = await runTerminateRole(operations, incarnation);

    expect(abandon).toHaveBeenCalledOnce();
    expect(abandon).toHaveBeenCalledWith({ role: 'reaper', pid: 6101, incarnation });
    expect(output.stderr).toBe('');
    expect(output.stdout).toContain('Authorized reaper role pid 6101');
    expect(output.stdout).toContain('The abandonment request sent no process signal and minted no absence.');
    expect(process.exitCode).toBe(0);
  });

  it('reports that an in-progress retry may already have signalled the process', async () => {
    const incarnation = testIncarnation(6101);
    const operations = createProviderProxyRoleTerminationCommandOperations({
      platform: 'linux',
      readProcessIncarnation: () => incarnation,
      retryReap: async () => ({ kind: 'reap-retry-requested' }),
      abandon: async () => ({
        kind: 'refused',
        reason:
          'This reaper cannot abandon its unattributable hold while a retry is in-progress and may already have sent a process signal. Retry the abandonment after the containment retry settles.',
      }),
    });

    const output = await runTerminateRole(operations, incarnation);

    expect(output.stdout).toBe('');
    expect(output.stderr).toContain('retry is in-progress and may already have sent a process signal');
    expect(output.stderr).toContain('This command does not send process signals.');
    expect(output.stderr).not.toContain('No signal was sent.');
    expect(process.exitCode).toBe(1);
  });

  it('surfaces a live-coordinator refusal with the coordinator-side command', async () => {
    const incarnation = testIncarnation(6101);
    const operations = createProviderProxyRoleTerminationCommandOperations({
      platform: 'linux',
      readProcessIncarnation: () => incarnation,
      retryReap: async () => ({ kind: 'reap-retry-requested' }),
      abandon: async () => ({
        kind: 'refused',
        reason:
          'Operator abandonment is refused while coordinator control is live. Use `coral-cli backend provider-proxy-set contain <set-token> --abandon-without-absence` through the coordinator.',
      }),
    });

    const output = await runTerminateRole(operations, incarnation);

    expect(output.stdout).toBe('');
    expect(output.stderr).toContain('coordinator control is live');
    expect(output.stderr).toContain('provider-proxy-set contain <set-token> --abandon-without-absence');
    expect(process.exitCode).toBe(1);
  });

  it('routes reap-failed recovery through the retry action without authorizing abandonment', async () => {
    const incarnation = testIncarnation(6101);
    const abandon = vi.fn(async () => ({ kind: 'abandoned' as const }));
    const retryReap = vi.fn(async () => ({ kind: 'reap-retry-requested' as const }));
    const operations = createProviderProxyRoleTerminationCommandOperations({
      platform: 'linux',
      readProcessIncarnation: () => incarnation,
      abandon,
      retryReap,
    });

    const output = await runTerminateRole(operations, incarnation, 'retry-role-reap');

    expect(abandon).not.toHaveBeenCalled();
    expect(retryReap).toHaveBeenCalledWith({ role: 'reaper', pid: 6101, incarnation });
    expect(output.stderr).toBe('');
    expect(output.stdout).toContain('Requested another containment reap');
    expect(output.stdout).toContain('retains containment ownership unless it confirms absence');
    expect(process.exitCode).toBe(0);
  });
});
