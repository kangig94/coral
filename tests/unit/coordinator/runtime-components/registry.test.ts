import { describe, expect, it, vi } from 'vitest';

import { KB_COMPONENT_ID, type RuntimeComponentId } from '#src/coordinator/runtime-components/contract.js';
import { createRuntimeComponentRegistry } from '#src/coordinator/runtime-components/registry.js';

import { createStubRuntimeComponent, runtimeComponentPhase } from './stub.js';

describe('createRuntimeComponentRegistry', () => {
  it('register + list + status surface the registered component', () => {
    const registry = createRuntimeComponentRegistry();
    const sub = createStubRuntimeComponent({
      id: KB_COMPONENT_ID,
      initialPhase: runtimeComponentPhase.online(KB_COMPONENT_ID),
    });
    registry.register(sub);

    expect(registry.list()).toEqual([{ id: KB_COMPONENT_ID, phase: 'online' }]);
    expect(registry.status(KB_COMPONENT_ID)).toEqual({ id: KB_COMPONENT_ID, phase: 'online' });
  });

  it('throws on duplicate registration', () => {
    const registry = createRuntimeComponentRegistry();
    const sub = createStubRuntimeComponent({
      id: KB_COMPONENT_ID,
      initialPhase: runtimeComponentPhase.online(KB_COMPONENT_ID),
    });
    registry.register(sub);
    expect(() => registry.register(sub)).toThrow(/already registered/);
  });

  it('initAll calls init on each registered component (fire-and-forget)', () => {
    const registry = createRuntimeComponentRegistry();
    const initSpy = vi.fn().mockResolvedValue(undefined);
    const sub = createStubRuntimeComponent({
      id: KB_COMPONENT_ID,
      initialPhase: runtimeComponentPhase.online(KB_COMPONENT_ID),
    });
    // Override the stub's init to observe invocation.
    (sub as unknown as { init: typeof initSpy }).init = initSpy;
    registry.register(sub);

    const ctrl = new AbortController();
    registry.initAll(ctrl.signal);

    expect(initSpy).toHaveBeenCalledWith(ctrl.signal);
  });

  it('initAll catches per-component init failures so siblings keep running', async () => {
    const registry = createRuntimeComponentRegistry();
    const failing = createStubRuntimeComponent({
      id: KB_COMPONENT_ID,
      initialPhase: runtimeComponentPhase.online(KB_COMPONENT_ID),
    });
    (failing as unknown as { init: () => Promise<void> }).init = () => Promise.reject(new Error('boom'));
    registry.register(failing);

    const ctrl = new AbortController();
    expect(() => registry.initAll(ctrl.signal)).not.toThrow();
    // Allow the rejected promise's per-sub catch to flush.
    await Promise.resolve();
  });

  it('disposeAll awaits every component and tolerates failures', async () => {
    const registry = createRuntimeComponentRegistry();
    const disposeSpy = vi.fn().mockResolvedValue(undefined);
    const sub = createStubRuntimeComponent({
      id: KB_COMPONENT_ID,
      initialPhase: runtimeComponentPhase.online(KB_COMPONENT_ID),
    });
    (sub as unknown as { dispose: typeof disposeSpy }).dispose = disposeSpy;
    registry.register(sub);

    const ctrl = new AbortController();
    await registry.disposeAll(ctrl.signal);
    expect(disposeSpy).toHaveBeenCalledWith(ctrl.signal);
  });

  it('disposeAll keeps disposing peers and resolves when one component dispose rejects', async () => {
    const registry = createRuntimeComponentRegistry();

    const failing = createStubRuntimeComponent({
      id: KB_COMPONENT_ID,
      initialPhase: runtimeComponentPhase.online(KB_COMPONENT_ID),
    });
    (failing as unknown as { dispose: () => Promise<void> }).dispose = () => Promise.reject(new Error('dispose boom'));
    registry.register(failing);

    const peerId = 'peer' as RuntimeComponentId;
    const peer = createStubRuntimeComponent({ id: peerId, initialPhase: runtimeComponentPhase.online(peerId) });
    const peerDisposeSpy = vi.fn().mockResolvedValue(undefined);
    (peer as unknown as { dispose: typeof peerDisposeSpy }).dispose = peerDisposeSpy;
    registry.register(peer);

    const ctrl = new AbortController();
    await expect(registry.disposeAll(ctrl.signal)).resolves.toBeUndefined();
    expect(peerDisposeSpy).toHaveBeenCalledWith(ctrl.signal);
  });
});
