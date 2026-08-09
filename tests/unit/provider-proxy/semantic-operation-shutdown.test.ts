import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `SemanticOperationRuntime.shutdown` (BLOCKING B6) coverage, kept in its own file rather than added to the
 * canonical `semantic-operation.test.ts`: that file is another agent's concurrent territory for the duration
 * of this fix. The mocking technique below (`#src/providers/bootstrap.js`'s `createBuiltInProviderRegistry`,
 * `#src/providers/app-server-transport.js`'s `spawnProviderServerTransport`) mirrors that file's own, proven
 * approach for driving `createSemanticOperationRuntime` without a real provider process.
 */

const providerRegistryDouble = vi.hoisted(() => ({
  rehydrateBinding: vi.fn(),
}));
vi.mock('#src/providers/bootstrap.js', () => ({
  createBuiltInProviderRegistry: () => ({
    connectAppServerHost: () => {},
    rehydrateBinding: (binding: unknown) => providerRegistryDouble.rehydrateBinding(binding),
  }),
}));

vi.mock('#src/providers/app-server-transport.js', async (importOriginal) => {
  const actual = await importOriginal<object>();
  return { ...actual, spawnProviderServerTransport: vi.fn() };
});

vi.mock('#src/infra/node-process.js', async (importOriginal) => {
  const actual = await importOriginal<object>();
  return { ...actual, probeProcessStartedAtSeconds: vi.fn(() => 1_700_000_000) };
});

import { createRealRuntime } from '#src/runtime/real.js';
import type { Runtime } from '#src/runtime/ports.js';
import type {
  BoundProvider,
  BoundProviderAppServerCapability,
  BoundProviderAppServerExecutionRuntime,
} from '#src/providers/bound-provider-contract.js';
import type { HostRef, ProviderEventBody, ProviderServerSpec } from '#src/providers/contract.js';
import { createOperationLedger, type OperationLedger, type ProviderOperationKey } from '#src/provider-proxy/ledger.js';
import type { Proxy } from '#src/provider-proxy/proxy.js';
import type { ProxyPreparedAppServerOperation } from '#src/provider-proxy/protocol.js';
import {
  createSemanticOperationRuntime,
  type ProxyAppServerHostAuthority,
} from '#src/provider-proxy/semantic-operation.js';
import { asJointContainmentReceipt, asReservation } from '#tests/helpers/provider-proxy-correlation.js';

const runtime: Runtime = createRealRuntime('prod');

beforeEach(() => {
  vi.mocked(providerRegistryDouble.rehydrateBinding).mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function testKey(operationId = 'op-1'): ProviderOperationKey {
  return { jobId: 'job-1', operationId };
}

function preparedFixture(): ProxyPreparedAppServerOperation {
  return {
    version: 1,
    provider: 'claude',
    binding: { provider: 'claude', kind: 'account', binding: {} },
    request: {
      action: 'exec',
      sessionId: 'session-1',
      prompt: 'hello',
      cwd: '/workspace',
      bypassPermissions: false,
      coralEnv: {},
    },
    persistedContinuity: null,
    baseEnv: {},
    protectedEnv: {},
    platform: 'linux',
  };
}

function unreachable(label: string): () => never {
  return () => {
    throw new Error(`unreachable in this test: ${label}`);
  };
}

function fakeHostSpec(provider = 'claude'): ProviderServerSpec {
  return { provider, command: provider, args: ['app-server'], cwd: '/workspace', leaseMode: 'job-exclusive' };
}

function fakeHostRef(provider = 'claude'): HostRef {
  return {
    provider,
    fingerprint: 'a'.repeat(64),
    instanceId: 'inst-1',
    leaseMode: 'job-exclusive',
    ownerJobId: 'job-1',
  };
}

function fakeHostAuthority(): ProxyAppServerHostAuthority {
  return {
    openSession: unreachable('hostAuthority.openSession') as unknown as ProxyAppServerHostAuthority['openSession'],
    attachSession: async () => null,
    rootIdentity: () => ({ pid: 4_242, processStartedAtSeconds: 1_700_000_000 }),
  };
}

function createTestProxy(): { proxy: Proxy; ledger: OperationLedger<ProxyPreparedAppServerOperation> } {
  const ledger = createOperationLedger<ProxyPreparedAppServerOperation>();
  const proxy: Proxy = {
    listen: async () => {},
    close: async () => {},
    ledger: () => ledger,
    reserveProviderEvent: (key, signal) => ledger.reserveEvent(key, signal),
    emitProviderEvent: (key, event, reservation) => {
      const providerSeq = ledger.nextProviderSeq(key);
      ledger.recordEvent(key, { providerSeq, frame: JSON.stringify(event) }, reservation);
      if (event.kind === 'terminal') ledger.transition(key, 'terminal-awaiting-settlement');
      if (event.kind === 'suspended') ledger.transition(key, 'suspended-awaiting-durable-decision');
    },
  };
  return { proxy, ledger };
}

function prepareAndActivate(
  ledger: OperationLedger<ProxyPreparedAppServerOperation>,
  key: ProviderOperationKey,
  prepared: ProxyPreparedAppServerOperation,
): void {
  const reserved = ledger.prepare({ key, reservation: asReservation('res'), prepared, nowMs: 0 });
  if (reserved.kind !== 'reserved') throw new Error('expected a reservation');
  ledger.recordPreparation(key, { pid: 1, processStartedAtSeconds: 1 }, asJointContainmentReceipt('contained'));
  const fingerprint = 'f'.repeat(64);
  ledger.beginActivation(key, asReservation('res'), 0, fingerprint);
  ledger.completeActivation(key, fingerprint, {
    state: 'executing',
    activationFingerprint: fingerprint,
    startedAt: new Date(0).toISOString(),
    hostRef: {
      provider: prepared.provider,
      fingerprint: '0'.repeat(64),
      instanceId: `test:${key.operationId}`,
      leaseMode: 'job-exclusive',
      ownerJobId: key.jobId,
    },
    committedThroughProviderSeq: 0,
  });
}

/** A `BoundProvider` test double whose `execute` never yields until its own signal aborts — a kernel that is
 *  genuinely still running when shutdown is asked to stop it. */
function fakeBoundProviderStuckUntilAborted(closeStaged: () => void): BoundProvider {
  return {
    name: 'claude',
    envelope: { provider: 'claude', kind: 'account', binding: {} },
    present: unreachable('present'),
    readiness: unreachable('readiness') as unknown as BoundProvider['readiness'],
    compareIdentity: unreachable('compareIdentity'),
    decodeContinuity: unreachable('decodeContinuity'),
    preflight: unreachable('preflight') as unknown as BoundProvider['preflight'],
    prepareExecution: () => ({
      kind: 'app-server',
      hostSpec: fakeHostSpec(),
      execute: async function* (execRuntime: BoundProviderAppServerExecutionRuntime): AsyncIterable<ProviderEventBody> {
        execRuntime.onHostRef(fakeHostRef());
        await new Promise<never>((_resolve, reject) => {
          execRuntime.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      },
    }),
    appServer: {
      supportsInterrupt: false,
      supportsProbe: false,
      openReplacement: async () => ({ hostRef: fakeHostRef(), close: closeStaged }),
      interrupt: unreachable('appServer.interrupt') as unknown as BoundProviderAppServerCapability['interrupt'],
      probe: unreachable('appServer.probe') as unknown as BoundProviderAppServerCapability['probe'],
    },
    artifacts: { kind: 'none', reason: 'test double' },
  };
}

describe('semantic-operation runtime: shutdown (BLOCKING B6)', () => {
  it('stops an executing kernel and releases its staged provider root', async () => {
    const { proxy, ledger } = createTestProxy();
    const key = testKey();
    const prepared = preparedFixture();
    prepareAndActivate(ledger, key, prepared);
    const closeStaged = vi.fn();

    providerRegistryDouble.rehydrateBinding.mockReturnValue({
      ok: true,
      value: fakeBoundProviderStuckUntilAborted(closeStaged),
    });

    const host = createSemanticOperationRuntime({ runtime, hostAuthority: fakeHostAuthority(), getProxy: () => proxy });
    await host.ensureProviderRoot(key, prepared);
    const start = host.host.start({ key, prepared });
    await expect(start.result).resolves.toEqual({ kind: 'started', hostRef: fakeHostRef() });

    // Still running: nothing has released the staged session yet.
    expect(closeStaged).not.toHaveBeenCalled();

    await host.shutdown('signal_abort');

    // The kernel was told to stop and its own staged app-server session was released — the same release
    // `host.stop`'s own `finally` performs, driven here by `shutdown` rather than `operation.stop.v1`.
    expect(closeStaged).toHaveBeenCalledOnce();
    // The proxy seam applies the supervisor-owned terminal transition, proving shutdown drove the kernel's abort
    // rather than merely awaiting it.
    expect(ledger.get(key)?.state).toBe('terminal-awaiting-settlement');
  });

  it('releases a staged-but-never-started provider root without touching a kernel', async () => {
    const { proxy, ledger } = createTestProxy();
    const key = testKey();
    const prepared = preparedFixture();
    const closeStaged = vi.fn();

    providerRegistryDouble.rehydrateBinding.mockReturnValue({
      ok: true,
      value: {
        name: 'claude',
        envelope: { provider: 'claude', kind: 'account', binding: {} },
        present: unreachable('present'),
        readiness: unreachable('readiness') as unknown as BoundProvider['readiness'],
        compareIdentity: unreachable('compareIdentity'),
        decodeContinuity: unreachable('decodeContinuity'),
        preflight: unreachable('preflight') as unknown as BoundProvider['preflight'],
        // Never called: this operation is never started, so `prepareExecution`/`execute` must not be reached.
        prepareExecution: unreachable('prepareExecution') as unknown as BoundProvider['prepareExecution'],
        appServer: {
          supportsInterrupt: false,
          supportsProbe: false,
          openReplacement: async () => ({ hostRef: fakeHostRef(), close: closeStaged }),
          interrupt: unreachable('appServer.interrupt') as unknown as BoundProviderAppServerCapability['interrupt'],
          probe: unreachable('appServer.probe') as unknown as BoundProviderAppServerCapability['probe'],
        },
        artifacts: { kind: 'none', reason: 'test double' },
      } satisfies BoundProvider,
    });

    const host = createSemanticOperationRuntime({ runtime, hostAuthority: fakeHostAuthority(), getProxy: () => proxy });
    await host.ensureProviderRoot(key, prepared);
    // Deliberately no `host.host.start` — this operation is staged only, mirroring a cancelled or
    // pre-activation-stopped reservation.

    await host.shutdown('signal_abort');

    expect(closeStaged).toHaveBeenCalledOnce();
    // Untouched: shutdown of a never-started operation must not fabricate ledger activity for it.
    expect(ledger.get(key)).toBeNull();
  });

  it('is a safe no-op when nothing is staged', async () => {
    const { proxy } = createTestProxy();
    const host = createSemanticOperationRuntime({ runtime, hostAuthority: fakeHostAuthority(), getProxy: () => proxy });

    await expect(host.shutdown('signal_abort')).resolves.toBeUndefined();
  });
});
