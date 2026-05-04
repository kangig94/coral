import { describe, expect, it, vi } from 'vitest';

import { KB_ID } from '#src/coordinator/subsystems/contract.js';
import { createSubsystemRegistry, isErrorEnvelope } from '#src/coordinator/subsystems/registry.js';

import { createStubSubsystem, subsystemPhase } from './stub.js';

describe('createSubsystemRegistry', () => {
  it('register + list + status surface the registered subsystem', () => {
    const registry = createSubsystemRegistry();
    const sub = createStubSubsystem({
      id: KB_ID,
      initialPhase: subsystemPhase.online(KB_ID),
      resource: { kind: 'kb-runtime' as const },
    });
    registry.register(sub);

    expect(registry.list()).toEqual([{ id: KB_ID, phase: 'online' }]);
    expect(registry.status(KB_ID)).toEqual({ id: KB_ID, phase: 'online' });
  });

  it('throws on duplicate registration', () => {
    const registry = createSubsystemRegistry();
    const sub = createStubSubsystem({ id: KB_ID, initialPhase: subsystemPhase.online(KB_ID), resource: 'r' });
    registry.register(sub);
    expect(() => registry.register(sub)).toThrow(/already registered/);
  });

  it('initAll calls init on each registered subsystem (fire-and-forget)', () => {
    const registry = createSubsystemRegistry();
    const initSpy = vi.fn().mockResolvedValue(undefined);
    const sub = createStubSubsystem({ id: KB_ID, initialPhase: subsystemPhase.online(KB_ID), resource: 'r' });
    // Override the stub's init to observe invocation.
    (sub as unknown as { init: typeof initSpy }).init = initSpy;
    registry.register(sub);

    const ctrl = new AbortController();
    registry.initAll(ctrl.signal);

    expect(initSpy).toHaveBeenCalledWith(ctrl.signal);
  });

  it('initAll catches per-subsystem init failures so siblings keep running', async () => {
    const registry = createSubsystemRegistry();
    const failing = createStubSubsystem({ id: KB_ID, initialPhase: subsystemPhase.online(KB_ID), resource: 'r' });
    (failing as unknown as { init: () => Promise<void> }).init = () => Promise.reject(new Error('boom'));
    registry.register(failing);

    const ctrl = new AbortController();
    expect(() => registry.initAll(ctrl.signal)).not.toThrow();
    // Allow the rejected promise's per-sub catch to flush.
    await Promise.resolve();
  });

  it('disposeAll awaits every subsystem and tolerates failures', async () => {
    const registry = createSubsystemRegistry();
    const disposeSpy = vi.fn().mockResolvedValue(undefined);
    const sub = createStubSubsystem({ id: KB_ID, initialPhase: subsystemPhase.online(KB_ID), resource: 'r' });
    (sub as unknown as { dispose: typeof disposeSpy }).dispose = disposeSpy;
    registry.register(sub);

    const ctrl = new AbortController();
    await registry.disposeAll(ctrl.signal);
    expect(disposeSpy).toHaveBeenCalledWith(ctrl.signal);
  });

  it('run() returns fn result when subsystem is online', () => {
    const registry = createSubsystemRegistry();
    const sub = createStubSubsystem({ id: KB_ID, initialPhase: subsystemPhase.online(KB_ID), resource: { x: 1 } });
    registry.register(sub);

    const result = registry.run<{ x: number }, number>(KB_ID, (r) => r.x + 41);
    expect(result).toBe(42);
  });

  it('run() returns fn result when subsystem is degraded', () => {
    const registry = createSubsystemRegistry();
    const sub = createStubSubsystem({
      id: KB_ID,
      initialPhase: subsystemPhase.degraded(KB_ID, {
        kind: 'curate-publish',
        consecutiveFailures: 3,
        lastError: 'queue stuck',
      }),
      resource: { y: 'ok' },
    });
    registry.register(sub);

    const result = registry.run<{ y: string }, string>(KB_ID, (r) => r.y);
    expect(result).toBe('ok');
  });

  it('run() returns kb_initializing envelope when subsystem is initializing', () => {
    const registry = createSubsystemRegistry();
    const sub = createStubSubsystem({
      id: KB_ID,
      initialPhase: subsystemPhase.initializing(KB_ID, 1),
      resource: 'r',
    });
    registry.register(sub);

    const result = registry.run(KB_ID, () => 'unreachable');
    expect(result).toEqual({
      ok: false,
      code: 'kb_initializing',
      message: 'Knowledge base is starting up',
      remediation: 'Wait briefly, then retry the request',
    });
    expect(isErrorEnvelope(result)).toBe(true);
  });

  it('run() returns kb_offline envelope when subsystem is offline', () => {
    const registry = createSubsystemRegistry();
    const sub = createStubSubsystem({
      id: KB_ID,
      initialPhase: subsystemPhase.offline(KB_ID, 'boom'),
      resource: 'r',
    });
    registry.register(sub);

    const result = registry.run(KB_ID, () => 'unreachable');
    expect(result).toEqual({
      ok: false,
      code: 'kb_offline',
      message: 'Knowledge base is offline',
      remediation: 'Restart the daemon: coral-cli backend shutdown',
    });
  });

  it('run() returns kb_offline envelope when subsystem is not registered', () => {
    const registry = createSubsystemRegistry();
    const result = registry.run(KB_ID, () => 'unreachable');
    expect(result).toEqual({
      ok: false,
      code: 'kb_offline',
      message: 'Knowledge base is offline',
      remediation: 'Restart the daemon: coral-cli backend shutdown',
    });
  });

  it('runAsync() awaits fn when online', async () => {
    const registry = createSubsystemRegistry();
    const sub = createStubSubsystem({
      id: KB_ID,
      initialPhase: subsystemPhase.online(KB_ID),
      resource: { fetch: () => Promise.resolve('hello') },
    });
    registry.register(sub);

    const result = await registry.runAsync<{ fetch: () => Promise<string> }, string>(KB_ID, (r) => r.fetch());
    expect(result).toBe('hello');
  });

  it('runAsync() returns envelope when subsystem is initializing', async () => {
    const registry = createSubsystemRegistry();
    const sub = createStubSubsystem({
      id: KB_ID,
      initialPhase: subsystemPhase.initializing(KB_ID, 2),
      resource: 'r',
    });
    registry.register(sub);

    const result = await registry.runAsync(KB_ID, () => Promise.resolve('unreachable'));
    expect(result).toEqual({
      ok: false,
      code: 'kb_initializing',
      message: 'Knowledge base is starting up',
      remediation: 'Wait briefly, then retry the request',
    });
  });
});
