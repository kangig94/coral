import { describe, expect, it } from 'vitest';

import { KiwiAnalyzerManager, isKiwiAnalyzerTerminalLoadError } from '#src/engines/kiwi/analyzer-manager.js';
import type { KiwiAnalyzer } from '#src/engines/kiwi/loader.js';
import type { TimerHandle } from '#src/infra/port-types.js';
import type { Runtime } from '#src/runtime/ports.js';
import { installedKiwiArtifactState, missingKiwiArtifactState } from '#tests/helpers/kiwi-artifact-state.js';

type FakeTimer = TimerHandle & {
  active: boolean;
  fn: () => void;
  ms: number;
};

function createRuntime(timers: FakeTimer[] = []): Runtime {
  return {
    time: {
      now: () => 1_000,
      setTimeout: (fn: () => void, ms: number) => {
        const timer: FakeTimer = { active: true, fn, ms };
        timers.push(timer);
        return timer;
      },
      clearTimeout: (handle: TimerHandle | null) => {
        if (handle !== null) {
          (handle as FakeTimer).active = false;
        }
      },
      sleep: async () => {},
      setInterval: () => ({ active: true, fn: () => {}, ms: 0 }),
      clearInterval: () => {},
    },
    paths: {
      coral: {
        engine: {
          dataDir: (name: string) => `/tmp/coral/engines/${name}`,
        },
      },
    },
  } as unknown as Runtime;
}

function installedState(installedAt = '2026-06-19T00:00:00.000Z') {
  return installedKiwiArtifactState(installedAt);
}

function modelOnlyState() {
  return missingKiwiArtifactState('wasm');
}

function createAnalyzer(label: string, dispose: () => Promise<void> | void = () => {}): KiwiAnalyzer {
  return {
    identity: {
      engine: 'kiwi',
      kiwiNlpVersion: '0.23.0',
      modelVersion: label,
      modelType: 'cong-global',
    },
    kiwi: {} as KiwiAnalyzer['kiwi'],
    tokenize: () => [],
    tokens: () => [],
    async dispose() {
      await dispose();
    },
  };
}

async function expectTerminalFailure(manager: KiwiAnalyzerManager, runtime: Runtime): Promise<void> {
  try {
    await manager.withAnalyzerLease(runtime, ['ko'], () => {});
    throw new Error('expected load failure');
  } catch (error: unknown) {
    expect(isKiwiAnalyzerTerminalLoadError(error)).toBe(true);
  }
}

describe('KiwiAnalyzerManager', () => {
  it('single-flights concurrent loads and exposes the lease through AsyncLocalStorage', async () => {
    const runtime = createRuntime();
    let loadCalls = 0;
    let resolveLoad!: () => void;
    const loadGate = new Promise<void>((resolve) => {
      resolveLoad = resolve;
    });
    const analyzer = createAnalyzer('a');
    const manager = new KiwiAnalyzerManager({
      idleTtlMs: 300_000,
      inspectArtifact: () => installedState(),
      loadAnalyzer: async () => {
        loadCalls += 1;
        await loadGate;
        return analyzer;
      },
      logger: () => {},
    });

    const first = manager.withAnalyzerLease(runtime, ['ko'], (lease) => {
      expect(lease.analyzer).toBe(analyzer);
      expect(manager.currentAnalyzer()).toBe(analyzer);
      return 'first';
    });
    const second = manager.withAnalyzerLease(runtime, ['ko'], (lease) => {
      expect(lease.analyzer).toBe(analyzer);
      expect(manager.currentAnalyzer()).toBe(analyzer);
      return 'second';
    });

    await Promise.resolve();
    expect(loadCalls).toBe(1);
    resolveLoad();

    await expect(Promise.all([first, second])).resolves.toEqual(['first', 'second']);
    expect(loadCalls).toBe(1);
  });

  it('eviction waits for active leases and marks unloaded only after dispose completes', async () => {
    const runtime = createRuntime();
    let disposeCalls = 0;
    let eviction!: Promise<void>;
    let evictionResolved = false;
    const manager = new KiwiAnalyzerManager({
      idleTtlMs: 300_000,
      inspectArtifact: () => installedState(),
      loadAnalyzer: async () =>
        createAnalyzer('a', () => {
          disposeCalls += 1;
        }),
      logger: () => {},
    });

    await manager.withAnalyzerLease(runtime, ['ko'], async () => {
      eviction = manager.evictIdleNow().then(() => {
        evictionResolved = true;
      });
      await Promise.resolve();
      expect(manager.status().state).toBe('evicting');
      expect(evictionResolved).toBe(false);
      expect(disposeCalls).toBe(0);
    });

    await eviction;
    expect(evictionResolved).toBe(true);
    expect(disposeCalls).toBe(1);
    expect(manager.status()).toEqual({ state: 'unloaded', leaseCount: 0 });
  });

  it('orders dispose before a post-eviction reload', async () => {
    const runtime = createRuntime();
    let loadCalls = 0;
    let resolveDispose!: () => void;
    const disposeGate = new Promise<void>((resolve) => {
      resolveDispose = resolve;
    });
    const manager = new KiwiAnalyzerManager({
      idleTtlMs: 300_000,
      inspectArtifact: () => installedState(),
      loadAnalyzer: async () => {
        loadCalls += 1;
        return createAnalyzer(`load-${loadCalls}`, loadCalls === 1 ? () => disposeGate : () => {});
      },
      logger: () => {},
    });

    await manager.withAnalyzerLease(runtime, ['ko'], (lease) => {
      expect(lease.analyzer?.identity.modelVersion).toBe('load-1');
    });

    const eviction = manager.evictIdleNow();
    const reload = manager.withAnalyzerLease(runtime, ['ko'], (lease) => {
      expect(lease.analyzer?.identity.modelVersion).toBe('load-2');
    });

    await Promise.resolve();
    expect(loadCalls).toBe(1);
    resolveDispose();
    await eviction;
    await reload;
    expect(loadCalls).toBe(2);
  });

  it('resets the idle eviction timer on activity', async () => {
    const timers: FakeTimer[] = [];
    const runtime = createRuntime(timers);
    let disposeCalls = 0;
    const manager = new KiwiAnalyzerManager({
      idleTtlMs: 300_000,
      inspectArtifact: () => installedState(),
      loadAnalyzer: async () =>
        createAnalyzer('a', () => {
          disposeCalls += 1;
        }),
      logger: () => {},
    });

    await manager.withAnalyzerLease(runtime, ['ko'], () => {});
    expect(timers).toHaveLength(1);
    expect(timers[0]?.active).toBe(true);

    await manager.withAnalyzerLease(runtime, ['ko'], () => {});
    expect(timers).toHaveLength(2);
    expect(timers[0]?.active).toBe(false);
    expect(timers[1]?.active).toBe(true);

    if (timers[0]?.active === true) {
      timers[0].fn();
    }
    await Promise.resolve();
    expect(disposeCalls).toBe(0);

    timers[1]?.fn();
    await Promise.resolve();
    expect(disposeCalls).toBe(1);
  });

  it('degrades to Intl baseline after terminal load failure and retries when WASM completes', async () => {
    const runtime = createRuntime();
    let loadCalls = 0;
    let state = modelOnlyState();
    const manager = new KiwiAnalyzerManager({
      idleTtlMs: 300_000,
      inspectArtifact: () => state,
      loadAnalyzer: async () => {
        loadCalls += 1;
        if (loadCalls === 1) {
          throw new Error('WASM missing');
        }
        return createAnalyzer('recovered');
      },
      logger: () => {},
    });

    await expectTerminalFailure(manager, runtime);
    expect(manager.effectiveDeclaredAnalyzers(['ko'], runtime)).toEqual([]);
    expect(manager.leaseReadiness(runtime, ['ko'])).toEqual({
      ready: true,
      state: 'degraded',
      reason: 'WASM missing',
    });

    await manager.withAnalyzerLease(runtime, ['ko'], (lease) => {
      expect(lease.analyzer).toBeNull();
      expect(lease.activeAnalyzers).toEqual([]);
    });
    expect(loadCalls).toBe(1);

    state = installedState('2026-06-19T00:01:00.000Z');
    expect(manager.leaseReadiness(runtime, ['ko'])).toEqual({ ready: false, state: 'unloaded' });
    expect(loadCalls).toBe(1);
  });

  it('recovers through effectiveDeclaredAnalyzers without a prior readiness probe', async () => {
    const runtime = createRuntime();
    let state = modelOnlyState();
    const manager = new KiwiAnalyzerManager({
      inspectArtifact: () => state,
      loadAnalyzer: async () => {
        throw new Error('WASM missing');
      },
      logger: () => {},
    });

    await expectTerminalFailure(manager, runtime);
    state = installedState('2026-06-19T00:01:00.000Z');

    expect(manager.effectiveDeclaredAnalyzers(['ko'], runtime)).toEqual(['ko']);
    expect(manager.status()).toEqual({ state: 'unloaded', leaseCount: 0 });
  });

  it('recovers through lease acquisition without a prior readiness or effective-analyzer probe', async () => {
    const runtime = createRuntime();
    let state = modelOnlyState();
    let loadCalls = 0;
    const manager = new KiwiAnalyzerManager({
      inspectArtifact: () => state,
      loadAnalyzer: async () => {
        loadCalls += 1;
        if (loadCalls === 1) {
          throw new Error('WASM missing');
        }
        return createAnalyzer('recovered');
      },
      logger: () => {},
    });

    await expectTerminalFailure(manager, runtime);
    state = installedState('2026-06-19T00:01:00.000Z');

    await manager.withAnalyzerLease(runtime, ['ko'], (lease) => {
      expect(lease.analyzer?.identity.modelVersion).toBe('recovered');
      expect(lease.activeAnalyzers).toEqual(['ko']);
    });
    expect(loadCalls).toBe(2);
  });

  it('records the pre-load artifact key when recovery completes before a failing load rejects', async () => {
    const runtime = createRuntime();
    let state = modelOnlyState();
    let loadCalls = 0;
    const manager = new KiwiAnalyzerManager({
      inspectArtifact: () => state,
      loadAnalyzer: async () => {
        loadCalls += 1;
        if (loadCalls === 1) {
          state = installedState('2026-06-19T00:01:00.000Z');
          throw new Error('load raced artifact publication');
        }
        return createAnalyzer('recovered-after-race');
      },
      logger: () => {},
    });

    await expectTerminalFailure(manager, runtime);
    expect(manager.leaseReadiness(runtime, ['ko'])).toEqual({ ready: false, state: 'unloaded' });

    await manager.withAnalyzerLease(runtime, ['ko'], (lease) => {
      expect(lease.analyzer?.identity.modelVersion).toBe('recovered-after-race');
    });
    expect(loadCalls).toBe(2);
  });

  it('recommends a daemon retry instead of equip when valid artifacts fail to initialize', async () => {
    const runtime = createRuntime();
    const logs: string[] = [];
    const manager = new KiwiAnalyzerManager({
      inspectArtifact: () => installedState(),
      loadAnalyzer: async () => {
        throw new Error('Emscripten initializer crashed');
      },
      logger: (message) => logs.push(message),
    });

    await expectTerminalFailure(manager, runtime);

    expect(logs).toEqual([expect.stringContaining('coral-cli backend shutdown')]);
    expect(logs.join('\n')).not.toContain('coral-cli expansion equip kiwi');
  });

  it('preserves the canonical equip remediation for missing runtime artifacts', async () => {
    const runtime = createRuntime();
    const logs: string[] = [];
    const manager = new KiwiAnalyzerManager({
      inspectArtifact: () => modelOnlyState(),
      loadAnalyzer: async () => {
        throw new Error(
          'Kiwi runtime artifacts are not installed (wasm missing). ' +
            'Run `coral-cli expansion equip kiwi` to install them.',
        );
      },
      logger: (message) => logs.push(message),
    });

    await expectTerminalFailure(manager, runtime);

    expect(logs.join('\n')).toContain('coral-cli expansion equip kiwi');
    expect(logs.join('\n')).not.toContain('coral-cli backend shutdown');
  });
});
