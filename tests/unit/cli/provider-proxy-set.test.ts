import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createProviderProxySetCommandOperations,
  registerBackendCommands,
  type ProviderProxySetCommandOperations,
} from '#src/cli/commands/backend.js';
import {
  encodeProviderProxySetAddress,
  type ProviderProxySetAddress,
} from '#src/coordinator/services/provider-proxy-set/identity.js';
import { IpcRpcError } from '#src/transport/ipc/client.js';
import type { ProviderProxySetContainResponse } from '#src/transport/rpc/catalog.js';

const address: ProviderProxySetAddress = {
  buildSetId: '11111111-1111-4111-8111-111111111111',
  hostFingerprint: 'a'.repeat(64),
  proxyInstanceId: '22222222-2222-4222-8222-222222222222',
};

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

async function runContain(
  result: ProviderProxySetContainResponse,
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
      }),
    ).resolves.toEqual(expect.objectContaining({ stdout: expect.stringContaining('Confirmed absence') }));
    expect(process.exitCode).toBe(0);

    await expect(
      runContain({
        kind: 'contained',
        setIdentity: address,
        disappearanceReceipt: 'proxy-group-absent',
        claimDischarge: { kind: 'initial-disposition-retry-owned' },
      }),
    ).resolves.toEqual(expect.objectContaining({ stderr: expect.stringContaining('still owns retry') }));
    expect(process.exitCode).toBe(75);

    await expect(
      runContain({
        kind: 'abandoned',
        setIdentity: address,
        processObservation: 'enforcer-unobservable',
        claimDischarge: { kind: 'initial-disposition-retry-owned' },
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        stderr: expect.stringContaining('accepted operator abandonment'),
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

    await expect(operations.contain({ setIdentity: address, abandonUnobservable: false })).resolves.toEqual({
      kind: 'unsupported-coordinator',
      setIdentity: address,
    });
  });
});
