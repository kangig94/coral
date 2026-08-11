import { describe, expect, it, vi } from 'vitest';

import type { ProviderEventBody, ProviderRequest } from '#src/providers/contract.js';
import type { BoundProviderAppServerExecutionRuntime } from '#src/providers/bound-provider-contract.js';
import { ProviderRegistry } from '#src/providers/registry.js';
import { collectProviderEvents } from '#src/providers/stream.js';
import { defineFakeProvider, type AppServerTestProvider } from '#tests/helpers/scripted-provider.js';
import { createDeferred } from '#tools/testing/deferred.js';

const REQUEST: ProviderRequest = {
  action: 'exec',
  sessionId: 'lifecycle-session',
  prompt: 'test lifecycle',
  cwd: '/workspace',
  bypassPermissions: false,
  coralEnv: {},
};

const TERMINAL: ProviderEventBody = {
  kind: 'terminal',
  terminal: { content: 'done', durationMs: 0, outcome: { kind: 'completed' } },
  diagnostics: {},
};

function harness(
  execute: AppServerTestProvider['execute'],
  subscribe: () => () => void = () => () => {},
  hostProvider = 'fixture',
) {
  const close = vi.fn();
  const closed = createDeferred<Error | void>();
  const registry = new ProviderRegistry();
  const definition = defineFakeProvider({
    name: 'fixture',
    execute,
    appServerLifecycle: {
      host: {
        provider: hostProvider,
        command: 'fixture',
        args: ['app-server'],
        cwd: '/workspace',
        leaseMode: 'job-exclusive',
      },
      interrupt: async () => {},
      onNotification: () => {},
      finalizeInterrupted: () => ({ kind: 'preserve' }),
    },
  });
  if (definition === undefined) throw new Error('missing fixture definition');
  registry.register(definition);
  registry.connectAppServerHost({
    openSession: async () => ({
      session: { rpc: async <R>() => ({}) as R, subscribe, closed: closed.promise },
      hostRef: {
        provider: 'fixture',
        fingerprint: '0'.repeat(64),
        instanceId: 'lifecycle-instance',
        leaseMode: 'job-exclusive',
        ownerJobId: 'lifecycle-job',
      },
      close,
    }),
    attachSession: async () => null,
  });
  const result = registry.rehydrateBinding({
    provider: 'fixture',
    kind: 'profile',
    binding: {
      profile: { canonicalLocation: '/fixture', routing: {} },
      guarantee: 'profile-only',
    },
  });
  if (!result.ok) throw new Error(result.failure.reason);
  const prepared = result.value.prepareExecution({
    request: REQUEST,
    baseEnv: {},
    protectedEnv: { CORAL_CHILD_PRINCIPAL_HANDLE: 'handle' },
    platform: 'linux',
    storage: { existsSync: () => false },
  });
  const runtime: BoundProviderAppServerExecutionRuntime = {
    transport: 'app-server',
    jobId: 'lifecycle-job',
    signal: new AbortController().signal,
    time: {
      now: () => 0,
      setTimeout,
      clearTimeout: (handle) => {
        if (handle !== null) clearTimeout(handle as ReturnType<typeof setTimeout>);
      },
    },
    storage: { readFileSync: () => '', statSync: () => ({}) as never, existsSync: () => false, readdirSync: () => [] },
    ids: { uuid: () => 'id', sha256: () => 'hash' },
    continuityBridge: { checkpoint: vi.fn(), transportClosed: vi.fn() },
    kbRoot: '/kb',
    onAppServerWaiting: vi.fn(),
    onHostRef: vi.fn(),
    onProviderTurnTerminal: vi.fn(),
  };
  if (prepared.kind !== 'app-server') throw new Error('Expected app-server prepared execution.');
  return { bound: result.value, close, closed, prepared, runtime };
}

describe('bound app-server execution lifecycle', () => {
  it('rejects a stable host labeled for another provider before acquisition', () => {
    // `hostSpec` is compiled eagerly at `prepareExecution()` — before any host is acquired, and before
    // `harness()` even returns a `prepared` to call `.execute()` on — so this provider-identity mismatch
    // surfaces there now, synchronously, rather than only once the returned generator is iterated.
    expect(() =>
      harness(
        async function* () {
          yield TERMINAL;
        },
        undefined,
        'other-provider',
      ),
    ).toThrow("Provider 'fixture' compiled a stable host labeled for 'other-provider'");
  });

  it('projects replacement authority to hostRef and close only', async () => {
    const test = harness(async function* () {
      yield TERMINAL;
    });
    const replacement = await test.bound.appServer?.openReplacement(
      { request: REQUEST, baseEnv: {}, platform: 'linux', storage: { existsSync: () => false } },
      { jobId: 'lifecycle-job' },
    );

    expect(Object.keys(replacement ?? {}).sort()).toEqual(['close', 'hostRef']);
    expect(replacement).not.toHaveProperty('session');
    replacement?.close();
  });

  it('closes the managed host when host publication throws', async () => {
    const test = harness(async function* () {
      yield TERMINAL;
    });
    (test.runtime as { onHostRef(hostRef: unknown): void }).onHostRef = () => {
      throw new Error('host publication failed');
    };

    await expect(collectProviderEvents(test.prepared.execute(test.runtime))).rejects.toThrow('host publication failed');
    expect(test.close).toHaveBeenCalledTimes(1);
  });

  it('closes the managed host when notification subscription throws', async () => {
    const test = harness(
      async function* () {
        yield TERMINAL;
      },
      () => {
        throw new Error('subscribe failed');
      },
    );

    await expect(collectProviderEvents(test.prepared.execute(test.runtime))).rejects.toThrow('subscribe failed');
    expect(test.close).toHaveBeenCalledTimes(1);
  });

  it('closes the managed host when provider iterator construction throws', async () => {
    const execute = (() => ({
      [Symbol.asyncIterator]() {
        throw new Error('iterator construction failed');
      },
    })) as AppServerTestProvider['execute'];
    const test = harness(execute);

    await expect(collectProviderEvents(test.prepared.execute(test.runtime))).rejects.toThrow(
      'iterator construction failed',
    );
    expect(test.close).toHaveBeenCalledTimes(1);
  });

  it('leaves transport-close interpretation to provider middleware', async () => {
    const pending = createDeferred<void>();
    const execute: AppServerTestProvider['execute'] = async function* () {
      await pending.promise;
      yield TERMINAL;
    };
    const test = harness(execute);
    const events = collectProviderEvents(test.prepared.execute(test.runtime));

    test.closed.resolve(new Error('transport closed'));
    await Promise.resolve();
    pending.resolve();

    await expect(events).resolves.toEqual([TERMINAL]);
    expect(test.runtime.continuityBridge.transportClosed).not.toHaveBeenCalled();
    expect(test.close).toHaveBeenCalledTimes(1);
  });
});
