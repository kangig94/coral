import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRealRuntime } from '#src/runtime/real.js';
import { buildEnforcementOutcomeHandlers, startProviderProxyRole } from '#src/provider-proxy/role-main.js';
import { controlExchangeForTest } from '#src/provider-proxy/control-client.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';
import { createDeferred } from '#tools/testing/deferred.js';

const owned = vi.hoisted(() => ({
  pairingClose: vi.fn(),
  proxyClose: vi.fn(async () => {}),
  shutdown: vi.fn(async () => {}),
}));
vi.mock('#src/provider-proxy/bootstrap-capsule.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  consumeProviderBootstrapCapsule: () => ({
    role: 'proxy',
    generation: 'gen2',
    flavor: 'prod',
    buildSetId: '11111111-1111-4111-8111-111111111111',
    hostFingerprint: 'b'.repeat(64),
    guardianInstanceId: '22222222-2222-4222-8222-222222222222',
    reaperInstanceId: '33333333-3333-4333-8333-333333333333',
    proxyInstanceId: '44444444-4444-4444-8444-444444444444',
    bootstrapNonce: 'a'.repeat(64),
    canonicalEndpoint: '/proxy.sock',
    guardianControlEndpoint: '/guardian.sock',
    proxyGuardianAuthSecret: 'c'.repeat(64),
  }),
}));
vi.mock('#src/provider-proxy/role-spawn.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  connectRoleControlWithRetry: async () => ({
    exchange: async () =>
      controlExchangeForTest({ kind: 'response', response: { kind: 'result', value: { state: 'paired' } } }),
    close: owned.pairingClose,
  }),
}));
vi.mock('#src/provider-proxy/provider-root-authority.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createProxyAppServerHostAuthority: () => ({}),
}));
vi.mock('#src/provider-proxy/semantic-operation-runner.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createSemanticOperationRuntime: () => ({ host: {}, stage: () => {}, shutdown: owned.shutdown }),
}));
vi.mock('#src/provider-proxy/proxy.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createProxy: () => ({ listen: async () => {}, close: owned.proxyClose }),
}));

afterEach(() => {
  vi.clearAllMocks();
});

function outcomeFixture() {
  const scheduled: Array<() => void> = [];
  const closed = createDeferred<void>();
  const close = vi.fn(async () => {});
  const exitProcess = vi.fn(() => {
    closed.resolve();
  });
  const markExited = vi.fn();
  const handlers = buildEnforcementOutcomeHandlers({
    role: 'reaper',
    roleIdentity: { pid: 5000, incarnation: testIncarnation(5000) },
    deadlines: { markExited },
    close,
    exitProcess,
    grantWasInstalled: () => true,
    now: () => 0,
    retryUnattributable: () => null,
    schedule: (callback) => {
      scheduled.push(callback);
    },
  });
  return { handlers, close, exitProcess, markExited, closed: closed.promise, dispatch: () => scheduled.shift()?.() };
}

describe('provider role shutdown', () => {
  it('closes owned proxy resources even when semantic shutdown fails', async () => {
    const failure = new Error('semantic shutdown incomplete');
    owned.shutdown.mockRejectedValueOnce(failure);
    const role = await startProviderProxyRole('/unused', {
      runtime: createRealRuntime('prod'),
      pluginRoot: '/tmp',
      baseDir: '/tmp',
      readProcessIncarnation: () => testIncarnation(5000),
      exitProcess: vi.fn(),
    });
    await expect(role.close()).rejects.toBe(failure);
    expect(owned.pairingClose).toHaveBeenCalledOnce();
    expect(owned.proxyClose).toHaveBeenCalledOnce();
  });

  it('keeps the role alive while containment is held', () => {
    const fixture = outcomeFixture();
    fixture.handlers.onOutcome({ kind: 'recorded-group-unattributable', reason: 'still held' });
    fixture.dispatch();
    expect(fixture.handlers.enforcementHoldStatus()?.kind).toBe('recorded-group-unattributable');
    expect(fixture.close).not.toHaveBeenCalled();
    expect(fixture.exitProcess).not.toHaveBeenCalled();
    expect(fixture.markExited).not.toHaveBeenCalled();
  });

  it('closes and exits after confirmed absence', async () => {
    const fixture = outcomeFixture();
    fixture.handlers.onOutcome({ kind: 'containment-absent', disappearanceReceipt: 'gone' });
    expect(fixture.exitProcess).not.toHaveBeenCalled();
    fixture.dispatch();
    await fixture.closed;
    expect(fixture.close).toHaveBeenCalledOnce();
    expect(fixture.markExited).toHaveBeenCalledOnce();
    expect(fixture.exitProcess).toHaveBeenCalledWith(0);
  });
});
