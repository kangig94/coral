import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createProviderProxySetCommandOperations,
  registerBackendCommands,
  type ProviderProxySetContainCommandResult,
  type ProviderProxySetCommandOperations,
} from '#src/cli/commands/backend.js';
import { encodeProviderProxySetAddress, type ProviderProxySetAddress } from '#src/provider-proxy/set-address.js';
import { TOOL_TIMEOUT_MS } from '#src/transport/http/sse.js';
import { IpcRpcError } from '#src/transport/ipc/client.js';
import { providerProxySetContainBooleanRpcSpec, providerProxySetContainRpcSpec } from '#src/transport/rpc/catalog.js';

const address: ProviderProxySetAddress = {
  buildSetId: '11111111-1111-4111-8111-111111111111',
  hostFingerprint: 'a'.repeat(64),
  proxyInstanceId: '22222222-2222-4222-8222-222222222222',
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
  it('turns a shipped coordinator method-not-found into a named no-verdict result', async () => {
    const operations = createProviderProxySetCommandOperations({
      getClient: async () =>
        ({
          request: async () => {
            throw new IpcRpcError({ code: -32601, message: 'Method not found' });
          },
        }) as never,
    });

    const result = operations.contain({ setIdentity: address, mode: 'contain' });
    await expect(result).resolves.toEqual({
      kind: 'unsupported-coordinator',
      setIdentity: address,
    });
    await expect(runContain(await result)).resolves.toEqual(
      expect.objectContaining({ stderr: expect.stringContaining('does not support') }),
    );
    expect(process.exitCode).toBe(75);
  });

  it('falls back to predecessor abandonment only after the addressed method is absent', async () => {
    const request = vi.fn(async (method: string) => {
      if (method === providerProxySetContainRpcSpec.name) {
        throw new IpcRpcError({ code: -32601, message: 'Method not found' });
      }
      return {
        kind: 'abandoned',
        setIdentity: address,
        enforcerObservations: [
          { role: 'guardian', observation: 'absent' },
          { role: 'reaper', observation: 'unknown' },
        ],
        claimDischarge: { kind: 'completed' },
        effect: abandonedEffect,
      };
    });
    const operations = createProviderProxySetCommandOperations({
      getClient: async () => ({ request }) as never,
    });

    const result = await operations.contain({ setIdentity: address, mode: 'abandon' });

    expect(request.mock.calls).toEqual([
      [
        providerProxySetContainRpcSpec.name,
        { setIdentity: address, mode: 'abandon' },
        expect.objectContaining({ timeoutMs: TOOL_TIMEOUT_MS }),
      ],
      [
        providerProxySetContainBooleanRpcSpec.name,
        { setIdentity: address, abandonWithoutAbsence: true },
        expect.objectContaining({ timeoutMs: TOOL_TIMEOUT_MS }),
      ],
    ]);
    expect(result).toEqual({
      kind: 'abandoned',
      setIdentity: address,
      enforcerObservations: [
        { role: 'guardian', observation: 'absent' },
        { role: 'reaper', observation: 'unknown' },
      ],
      claimDischarge: { kind: 'completed' },
      effect: abandonedEffect,
    });
    await expect(runContain(result)).resolves.toEqual(
      expect.objectContaining({ stdout: expect.stringContaining('was abandoned') }),
    );
    expect(process.exitCode).toBe(0);
  });

  it('bounds containment IPC and names a timed-out accepted request as a no-verdict', async () => {
    const request = vi.fn().mockRejectedValue(
      Object.assign(new Error('Failed to connect to the Coral coordinator.'), {
        context: { cause: 'IPC connection timed out after 300000ms' },
      }),
    );
    const operations = createProviderProxySetCommandOperations({
      getClient: async () => ({ request }) as never,
    });

    const result = await operations.contain({ setIdentity: address, mode: 'contain' });

    expect(request).toHaveBeenCalledWith(
      providerProxySetContainRpcSpec.name,
      { setIdentity: address, mode: 'contain' },
      expect.objectContaining({ timeoutMs: TOOL_TIMEOUT_MS }),
    );
    expect(result).toEqual({ kind: 'timeout', setIdentity: address });
    const output = await runContain(result);
    expect(output.stderr).toContain('a process signal or representation release may already have happened');
    expect(output.stderr).toContain('run coral-cli backend status before deciding whether to retry');
    expect(process.exitCode).toBe(75);
  });
});
