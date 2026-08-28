import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createProviderProxySetCommandOperations,
  registerBackendCommands,
  type ProviderProxySetContainCommandResult,
  type ProviderProxySetCommandOperations,
} from '#src/cli/commands/backend.js';
import { encodeProviderProxySetAddress, type ProviderProxySetAddress } from '#src/provider-proxy/set-address.js';
import { IpcRpcError } from '#src/transport/ipc/client.js';
import { providerProxySetContainResponseSchema } from '#src/transport/rpc/catalog.js';

const address: ProviderProxySetAddress = {
  buildSetId: '11111111-1111-4111-8111-111111111111',
  hostFingerprint: 'a'.repeat(64),
  proxyInstanceId: '22222222-2222-4222-8222-222222222222',
};
const containedEffect = {
  signalsSent: ['SIGTERM'] as const,
  containmentAbsent: true,
  representationAction: 'absence-release-started' as const,
};
const abandonedEffect = {
  signalsSent: [] as const,
  containmentAbsent: false,
  representationAction: 'abandonment-release-started' as const,
};

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

async function runContain(
  result: ProviderProxySetContainCommandResult,
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
  const providerProxySets: ProviderProxySetCommandOperations = { contain: async () => result };
  const program = new Command();
  program.exitOverride();
  registerBackendCommands(program, { providerProxySets });
  await program.parseAsync([
    'node',
    'coral-cli',
    'backend',
    'provider-proxy-set',
    'contain',
    encodeProviderProxySetAddress(address),
  ]);
  return { stdout, stderr };
}

describe('backend provider-proxy-set contain', () => {
  it('composes successful containment with the claim-discharge discriminator', async () => {
    await expect(
      runContain({
        kind: 'contained',
        setIdentity: address,
        disappearanceReceipt: 'proxy-group-absent',
        claimDischarge: { kind: 'completed' },
        effect: containedEffect,
      }),
    ).resolves.toEqual(expect.objectContaining({ stdout: expect.stringContaining('was contained') }));
    expect(process.exitCode).toBe(0);

    await expect(
      runContain({
        kind: 'contained',
        setIdentity: address,
        disappearanceReceipt: 'proxy-group-absent',
        claimDischarge: { kind: 'initial-disposition-retry-owned' },
        effect: containedEffect,
      }),
    ).resolves.toEqual(expect.objectContaining({ stderr: expect.stringContaining('still owns retry') }));
    expect(process.exitCode).toBe(75);

    await expect(
      runContain({
        kind: 'abandoned',
        setIdentity: address,
        enforcerObservations: [
          { role: 'guardian', observation: 'absent' },
          { role: 'reaper', observation: 'unknown' },
        ],
        claimDischarge: { kind: 'initial-disposition-retry-owned' },
        effect: abandonedEffect,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        stderr: expect.stringContaining('guardian=absent, reaper=unknown'),
      }),
    );
    expect(process.exitCode).toBe(75);

    await expect(
      runContain({
        kind: 'contained',
        setIdentity: address,
        disappearanceReceipt: 'proxy-group-absent',
        claimDischarge: {
          kind: 'operational-retry-owned',
          incidents: [
            {
              stage: 'disappearance-delivery',
              operation: {
                jobId: '33333333-3333-4333-8333-333333333333',
                operationId: '44444444-4444-4444-8444-444444444444',
                proxyInstanceId: address.proxyInstanceId,
                buildSetId: address.buildSetId,
              },
              code: 'disappearance_consumer_unavailable',
              reason: 'store busy',
              nextAttemptAtMs: 1,
            },
          ],
        },
        effect: containedEffect,
      }),
    ).resolves.toEqual(expect.objectContaining({ stderr: expect.stringContaining('retry') }));
    expect(process.exitCode).toBe(75);
  });

  it('turns a shipped coordinator method-not-found into a named no-verdict result', async () => {
    const operations = createProviderProxySetCommandOperations({
      getClient: async () =>
        ({
          request: async () => {
            throw new IpcRpcError({ code: -32601, message: 'Method not found' });
          },
        }) as never,
    });

    await expect(operations.contain({ setIdentity: address, abandonWithoutAbsence: false })).resolves.toEqual({
      kind: 'unsupported-coordinator',
      setIdentity: address,
    });
  });

  it('renders a stale authorization with the signal that was already delivered', async () => {
    const output = await runContain({
      kind: 'authorization-stale',
      setIdentity: address,
      effect: {
        signalsSent: ['SIGTERM'],
        containmentAbsent: false,
        representationAction: 'none',
      },
    });

    expect(output.stderr).toContain('SIGTERM was sent');
    expect(output.stderr).toContain('recorded-containment absence was not confirmed');
    expect(output.stderr).toContain('Coral did not start representation release');
    expect(process.exitCode).toBe(75);
  });

  it('turns the shipped draining response body into a named no-verdict result', async () => {
    const operations = createProviderProxySetCommandOperations({
      getClient: async () =>
        ({
          request: async () => ({ code: 'backend_shutting_down', message: 'Backend shutting down' }),
        }) as never,
    });

    const result = await operations.contain({ setIdentity: address, abandonWithoutAbsence: false });
    expect(result).toEqual({
      kind: 'coordinator-draining',
      setIdentity: address,
    });
    await expect(runContain(result)).resolves.toEqual(
      expect.objectContaining({ stderr: expect.stringContaining('the coordinator is shutting down') }),
    );
    expect(process.exitCode).toBe(75);
  });

  it('rejects containment results that the producer cannot make', () => {
    expect(
      providerProxySetContainResponseSchema.safeParse({
        kind: 'contained',
        setIdentity: address,
        disappearanceReceipt: 'receipt',
        claimDischarge: { kind: 'operational-retry-owned', incidents: [] },
      }).success,
    ).toBe(false);
    expect(
      providerProxySetContainResponseSchema.safeParse({
        kind: 'not-held',
        setIdentity: address,
        state: 'future-state',
      }).success,
    ).toBe(false);
    expect(
      providerProxySetContainResponseSchema.safeParse({
        kind: 'enforcer-alive',
        setIdentity: address,
        enforcerObservations: [
          { role: 'guardian', observation: 'alive' },
          { role: 'guardian', observation: 'absent' },
        ],
      }).success,
    ).toBe(false);
    expect(
      providerProxySetContainResponseSchema.safeParse({
        kind: 'enforcer-unobservable',
        setIdentity: address,
        enforcerObservations: [
          { role: 'guardian', observation: 'alive' },
          { role: 'reaper', observation: 'unknown' },
        ],
      }).success,
    ).toBe(false);
    expect(
      providerProxySetContainResponseSchema.safeParse({
        kind: 'abandoned',
        setIdentity: address,
        enforcerObservations: [
          { role: 'guardian', observation: 'absent' },
          { role: 'reaper', observation: 'absent' },
        ],
        claimDischarge: { kind: 'completed' },
      }).success,
    ).toBe(false);
  });

  it('turns a structurally identified unsupported result into a named no-verdict', async () => {
    const operations = createProviderProxySetCommandOperations({
      getClient: async () =>
        ({
          request: async () => ({ kind: 'not-held', setIdentity: address, state: 'future-state' }),
        }) as never,
    });

    const result = await operations.contain({ setIdentity: address, abandonWithoutAbsence: false });
    expect(result).toEqual({ kind: 'unsupported-coordinator-result', setIdentity: address });
    await runContain(result);
    expect(process.exitCode).toBe(75);
  });
});
