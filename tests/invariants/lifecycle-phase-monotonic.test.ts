import { describe, expect, it } from 'vitest';

import { createRuntimeState } from '#src/coordinator/lifecycle.js';
import { createRuntimeComponentRegistry } from '#src/coordinator/runtime-components/registry.js';

function runtimeState() {
  return createRuntimeState(1_000, createRuntimeComponentRegistry());
}

describe('lifecycle-phase-monotonic invariant', () => {
  it('allows the normal startup and shutdown sequence', () => {
    const state = runtimeState();

    state.setLifecycle('kernel-ready');
    state.setLifecycle('running');
    state.setLifecycle('draining');
    state.setLifecycle('stopped');

    expect(state.getLifecycle()).toBe('stopped');
  });

  it('forbids skipping kernel-ready when going from starting to running', () => {
    const state = runtimeState();

    expect(() => state.setLifecycle('running')).toThrow(/Invalid lifecycle transition: starting -> running/);
  });

  it('forbids backward transitions', () => {
    const state = runtimeState();

    state.setLifecycle('kernel-ready');
    state.setLifecycle('running');

    expect(() => state.setLifecycle('kernel-ready')).toThrow(/Invalid lifecycle transition: running -> kernel-ready/);
  });

  it('allows early failure collapse to stopped', () => {
    const state = runtimeState();

    state.setLifecycle('stopped');

    expect(state.getLifecycle()).toBe('stopped');
  });
});
