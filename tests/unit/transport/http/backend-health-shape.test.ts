// AC10a: `/health.subsystems` is an array of transport subsystem-status entries
// (4-phase tagged union per `id`). `mutationBlocked` and `consumerStuck`
// move from `subsystems.kb` to top-level `diagnostics`. The validator
// pins this shape so external consumers can rely on the structure.

import { describe, expect, it } from 'vitest';

import { isBackendHealth, type BackendHealth } from '#src/transport/http/backend/health.js';

const HEALTHY_BASE: BackendHealth = {
  status: 'ok',
  kernel: { phase: 'running', readyAt: 1_700_000_000_000 },
  version: '0.7.1',
  bundleHash: 'hash-1234',
  flavor: 'prod',
  instanceId: 'instance-1',
  namespace: 'test-ns',
  uptimeMs: 1000,
  active: 0,
  activeJobs: 0,
  inflightRequests: 0,
  queueDepth: 0,
  textProjectionState: 'idle',
  subsystems: [{ id: 'kb', phase: 'online' }],
};

describe('/health typed shape (AC10a)', () => {
  it('accepts a healthy shape with one online subsystem and no diagnostics', () => {
    expect(isBackendHealth(HEALTHY_BASE)).toBe(true);
  });

  it('accepts an empty subsystems array', () => {
    expect(isBackendHealth({ ...HEALTHY_BASE, subsystems: [] })).toBe(true);
  });

  it('accepts an initializing subsystem with attempt count', () => {
    const initializing: BackendHealth = {
      ...HEALTHY_BASE,
      subsystems: [{ id: 'kb', phase: 'initializing', attempt: 2 }],
    };
    expect(isBackendHealth(initializing)).toBe(true);
  });

  it('accepts a degraded subsystem with curate-publish reason', () => {
    const degraded: BackendHealth = {
      ...HEALTHY_BASE,
      subsystems: [
        {
          id: 'kb',
          phase: 'degraded',
          reason: { kind: 'curate-publish', consecutiveFailures: 3, lastError: 'publish timed out' },
        },
      ],
    };
    expect(isBackendHealth(degraded)).toBe(true);
  });

  it('accepts an offline subsystem with reason and last log line', () => {
    const offline: BackendHealth = {
      ...HEALTHY_BASE,
      subsystems: [
        { id: 'kb', phase: 'offline', reason: 'init failed', lastLogLine: '[subsystem:kb] catalog scan failed' },
      ],
    };
    expect(isBackendHealth(offline)).toBe(true);
  });

  it('accepts an offline subsystem diagnostic with boot failure context', () => {
    const offline: BackendHealth = {
      ...HEALTHY_BASE,
      subsystems: [
        {
          id: 'kb',
          phase: 'offline',
          reason: 'frontmatter parse failed',
          diagnostic: {
            attempts: 4,
            failedStep: 'I2 corpus freshness rescan',
            retry: 'restart-daemon',
            lastErrorStack: 'Error: frontmatter parse failed',
          },
        },
      ],
    };
    expect(isBackendHealth(offline)).toBe(true);
  });

  it('accepts a blocked-mutation diagnostic carrying full context', () => {
    const blocked: BackendHealth = {
      ...HEALTHY_BASE,
      diagnostics: { mutationBlocked: { owner: 'reindex', ageMs: 5000, signaledAtMs: 1234567890 } },
    };
    expect(isBackendHealth(blocked)).toBe(true);
  });

  it('accepts a stuck-consumer diagnostic carrying per-consumer elapsedSinceStopMs', () => {
    const stuck: BackendHealth = {
      ...HEALTHY_BASE,
      diagnostics: {
        consumerStuck: [
          { id: 'orama-base', elapsedSinceStopMs: 2500 },
          { id: 'needle-base', authority: 'journal', cursor: 42, elapsedSinceStopMs: 100 },
          {
            id: 'corpus-projection',
            authority: 'corpus',
            snapshotId: 'snapshot-a',
            contentSeq: 12,
            metadataSeq: 34,
            elapsedSinceStopMs: 500,
          },
        ],
      },
    };
    expect(isBackendHealth(stuck)).toBe(true);
  });

  it('accepts kernel.readyAt === null while still starting', () => {
    const starting: BackendHealth = {
      ...HEALTHY_BASE,
      status: 'starting',
      kernel: { phase: 'starting', readyAt: null },
    };
    expect(isBackendHealth(starting)).toBe(true);
  });

  it('accepts text projection fetch and reindex states', () => {
    expect(isBackendHealth({ ...HEALTHY_BASE, textProjectionState: 'fetching' })).toBe(true);
    expect(isBackendHealth({ ...HEALTHY_BASE, textProjectionState: 'reindexing' })).toBe(true);
  });

  it('accepts resource counters for daemon liveness diagnostics', () => {
    const withResources: BackendHealth = {
      ...HEALTHY_BASE,
      resources: {
        rssBytes: 1024,
        heapUsedBytes: 512,
        eventLoopLagMs: 3,
        ipcOpenSockets: 2,
        eventStreamResponses: 1,
        fdCount: 20,
      },
    };
    expect(isBackendHealth(withResources)).toBe(true);
  });

  it('accepts KB child supervisor health', () => {
    const withKbChild: BackendHealth = {
      ...HEALTHY_BASE,
      kbChild: {
        enabled: true,
        phase: 'online',
        generation: 2,
        pid: 12345,
        startedAt: 1_700_000_000_010,
        readyAt: 1_700_000_000_050,
        entrypoint: '/plugin/bridge/coral-backend.cjs',
        pendingRequests: 0,
        lastHeartbeatAt: 1_700_000_000_060,
        lastHeartbeatLatencyMs: 3,
        childUptimeMs: 50,
        kbRead: {
          phase: 'ready',
          initializedAt: 1_700_000_000_055,
        },
        lastExit: {
          code: 0,
          signal: null,
          at: 1_700_000_000_000,
          uptimeMs: 500,
        },
      },
    };
    expect(isBackendHealth(withKbChild)).toBe(true);
  });

  it('rejects malformed KB child supervisor health', () => {
    const malformed = {
      ...HEALTHY_BASE,
      kbChild: {
        enabled: true,
        phase: 'online',
        generation: '2',
        pid: 12345,
        startedAt: 1_700_000_000_010,
        readyAt: 1_700_000_000_050,
      },
    };
    expect(isBackendHealth(malformed)).toBe(false);
  });

  it('rejects malformed resource counters', () => {
    const malformed = {
      ...HEALTHY_BASE,
      resources: {
        rssBytes: '1024',
        heapUsedBytes: 512,
        eventLoopLagMs: 3,
        ipcOpenSockets: 2,
        eventStreamResponses: 1,
      },
    };
    expect(isBackendHealth(malformed)).toBe(false);
  });

  it('rejects a `mutationBlocked` shape missing required diagnostic fields', () => {
    const malformed = {
      ...HEALTHY_BASE,
      diagnostics: { mutationBlocked: { owner: 'reindex' } },
    };
    expect(isBackendHealth(malformed)).toBe(false);
  });

  it('rejects a `consumerStuck` entry missing elapsedSinceStopMs', () => {
    const malformed = {
      ...HEALTHY_BASE,
      diagnostics: { consumerStuck: [{ id: 'orama-base' }] },
    };
    expect(isBackendHealth(malformed)).toBe(false);
  });

  it('rejects the legacy `subsystems.kb.kind` object shape (clean-slate cost)', () => {
    // Pre-AC10a responses returned `subsystems` as a record with `kb.kind`.
    // The validator must fail-loud on that shape so the contract change
    // surfaces rather than silently parsing as a degenerate structure.
    const legacy = {
      ...HEALTHY_BASE,
      subsystems: { kb: { kind: 'ok' }, kbCurate: 'ok', discuss: 'ok' },
    };
    expect(isBackendHealth(legacy)).toBe(false);
  });

  it('rejects an unknown phase string', () => {
    const malformed = { ...HEALTHY_BASE, subsystems: [{ id: 'kb', phase: 'unavailable' }] };
    expect(isBackendHealth(malformed)).toBe(false);
  });

  it('rejects a degraded subsystem missing the reason object', () => {
    const malformed = { ...HEALTHY_BASE, subsystems: [{ id: 'kb', phase: 'degraded' }] };
    expect(isBackendHealth(malformed)).toBe(false);
  });

  it('rejects a malformed offline subsystem diagnostic', () => {
    const malformed = {
      ...HEALTHY_BASE,
      subsystems: [
        {
          id: 'kb',
          phase: 'offline',
          reason: 'init failed',
          diagnostic: { attempts: '4', retry: 'later' },
        },
      ],
    };
    expect(isBackendHealth(malformed)).toBe(false);
  });

  it('rejects a negative offline subsystem diagnostic attempt count', () => {
    const malformed = {
      ...HEALTHY_BASE,
      subsystems: [
        {
          id: 'kb',
          phase: 'offline',
          reason: 'init failed',
          diagnostic: { attempts: -1, retry: 'restart-daemon' },
        },
      ],
    };
    expect(isBackendHealth(malformed)).toBe(false);
  });

  it('rejects an unknown kernel phase', () => {
    const malformed = {
      ...HEALTHY_BASE,
      kernel: { phase: 'frobnicating', readyAt: 0 },
    };
    expect(isBackendHealth(malformed)).toBe(false);
  });

  it('rejects an unknown text projection state', () => {
    const malformed = {
      ...HEALTHY_BASE,
      textProjectionState: 'indexing',
    };
    expect(isBackendHealth(malformed)).toBe(false);
  });
});
