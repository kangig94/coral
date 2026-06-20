import { describe, expect, it } from 'vitest';

import {
  KiwiAnalyzerManager,
  isKiwiAnalyzerTerminalLoadError,
} from '#src/engines/kiwi/analyzer-manager.js';
import type { KiwiAnalyzer } from '#src/engines/kiwi/loader.js';
import type { KiwiModelArtifactState } from '#src/engines/kiwi/model-artifact.js';
import type { TimerHandle } from '#src/infra/port-types.js';
import type { Runtime } from '#src/runtime/ports.js';

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

function installedState(installedAt = '2026-06-19T00:00:00.000Z'): KiwiModelArtifactState {
  return {
    targetDir: '/tmp/kiwi',
    manifestPath: '/tmp/kiwi/manifest.json',
    installed: true,
    missingFiles: [],
    manifest: {
      packageId: 'kiwi',
      kiwiNlpVersion: '0.23.0',
      modelVersion: '0.23.0',
      modelType: 'cong-global',
      sourceUrl: 'https://example.invalid/kiwi.tgz',
      archiveSha256: 'digest',
      archiveSizeBytes: 1,
      files: [
        'sj.morph',
        'default.dict',
        'dialect.dict',
        'multi.dict',
        'typo.dict',
        'combiningRule.txt',
        'cong.mdl',
        'extract.mdl',
        'nounchr.mdl',
      ],
      installedAt,
    },
  };
}

function missingState(): KiwiModelArtifactState {
  return {
    targetDir: '/tmp/kiwi',
    manifestPath: '/tmp/kiwi/manifest.json',
    installed: false,
    missingFiles: ['cong.mdl'],
    manifest: null,
  };
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
      inspectModelArtifact: () => installedState(),
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
      inspectModelArtifact: () => installedState(),
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
      inspectModelArtifact: () => installedState(),
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
      inspectModelArtifact: () => installedState(),
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

  it('degrades to Intl baseline after terminal load failure and retries when the model changes', async () => {
    const runtime = createRuntime();
    let loadCalls = 0;
    let state = missingState();
    const manager = new KiwiAnalyzerManager({
      idleTtlMs: 300_000,
      inspectModelArtifact: () => state,
      loadAnalyzer: async () => {
        loadCalls += 1;
        if (loadCalls === 1) {
          throw new Error('model missing');
        }
        return createAnalyzer('recovered');
      },
      logger: () => {},
    });

    try {
      await manager.withAnalyzerLease(runtime, ['ko'], () => {});
      throw new Error('expected load failure');
    } catch (error: unknown) {
      expect(isKiwiAnalyzerTerminalLoadError(error)).toBe(true);
    }
    expect(manager.effectiveDeclaredAnalyzers(['ko'], runtime)).toEqual([]);

    await manager.withAnalyzerLease(runtime, ['ko'], (lease) => {
      expect(lease.analyzer).toBeNull();
      expect(lease.activeAnalyzers).toEqual([]);
    });
    expect(loadCalls).toBe(1);

    state = installedState('2026-06-19T00:01:00.000Z');
    await manager.withAnalyzerLease(runtime, ['ko'], (lease) => {
      expect(lease.analyzer?.identity.modelVersion).toBe('recovered');
      expect(lease.activeAnalyzers).toEqual(['ko']);
    });
    expect(manager.effectiveDeclaredAnalyzers(['ko'], runtime)).toEqual(['ko']);
    expect(loadCalls).toBe(2);
  });
});
