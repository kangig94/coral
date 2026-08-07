import { describe, expect, it, vi } from 'vitest';

import { RecoveryService, type RecoveryServiceDeps } from '#src/coordinator/services/recovery/service.js';
import { AbortRegistry } from '#src/jobs/shell/abort-registry.js';
import { createRealRuntime } from '#src/runtime/real.js';

/**
 * `RecoveryService.registerInheritedAppServerAbort` is the fix for finding 1: the only path that gives
 * `coral-cli abort` something real to reach for a job whose operation this coordinator generation adopted
 * from a predecessor rather than activated itself (`interruptAppServerJob` refuses on purpose for exactly that
 * job — see its own doc). These tests exercise the method against a real `AbortRegistry`, the same class
 * `ExecutionService` composes it with in production, so `abort()`'s reported outcome is proven against the
 * actual registry contract rather than a hand-rolled fake of it.
 */
function createService(overrides: Partial<RecoveryServiceDeps> = {}): {
  service: RecoveryService;
  abortRegistry: AbortRegistry;
} {
  const runtime = createRealRuntime('prod');
  const abortRegistry = new AbortRegistry(runtime.ids);
  const deps: RecoveryServiceDeps = {
    runtime,
    sessionManager: {} as never,
    abortRegistry,
    backendNamespace: 'tests',
    bundleHash: 'test-bundle',
    progressStore: {} as never,
    launchAdmission: {} as never,
    launchRecovery: {} as never,
    providerRegistry: {} as never,
    jobPools: new Map(),
    launchOrchestrator: {} as never,
    childPrincipalRegistry: {} as never,
    parentPrincipal: {} as never,
    ...overrides,
  };
  return { service: new RecoveryService(deps), abortRegistry };
}

describe('RecoveryService.registerInheritedAppServerAbort', () => {
  it('wires the operation registry-backed onAbort onto the ordinary abort registry', () => {
    const stop = vi.fn();
    const { service, abortRegistry } = createService({ operations: { stop } });

    expect(abortRegistry.has('inherited-job')).toBe(false);
    service.registerInheritedAppServerAbort('inherited-job');
    expect(abortRegistry.has('inherited-job')).toBe(true);

    // Proves the reported outcome now matches reality: `abort()` finds the job (no longer `notFound`) and the
    // signal it fires actually reaches the operation registry's `stop`, not a no-op.
    const result = abortRegistry.abort(['inherited-job']);
    expect(result).toEqual({ aborted: ['inherited-job'], notFound: [] });
    expect(stop).toHaveBeenCalledWith('inherited-job', 'signal_abort');
  });

  it('is a silent no-op for the abort signal when no operations port was composed', () => {
    const { service, abortRegistry } = createService();

    service.registerInheritedAppServerAbort('inherited-job');
    // No `operations` port composed (mirrors a coordinator build with proxied operations disabled): the
    // registration itself still succeeds, and firing it must not throw even though there is nothing to stop.
    expect(() => abortRegistry.abort(['inherited-job'])).not.toThrow();
  });
});
