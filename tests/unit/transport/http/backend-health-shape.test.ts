import { describe, expect, it } from 'vitest';

import { parseBackendHealth, type BackendHealth } from '#src/transport/http/backend/health.js';
import { encodeProviderProxySetAddress } from '#src/provider-proxy/set-address.js';

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
  components: [{ id: 'kb', phase: 'online' }],
};

const PROVIDER_PROXY_SET = {
  setIdentity: {
    buildSetId: '11111111-1111-4111-8111-111111111111',
    hostFingerprint: 'a'.repeat(64),
    proxyInstanceId: '22222222-2222-4222-8222-222222222222',
  },
  setToken: encodeProviderProxySetAddress({
    buildSetId: '11111111-1111-4111-8111-111111111111',
    hostFingerprint: 'a'.repeat(64),
    proxyInstanceId: '22222222-2222-4222-8222-222222222222',
  }),
  disposition: 'held',
  cause: 'closed',
  attempts: 2,
  elapsedMs: 500,
  boundMs: 23_000,
  liveClaims: 0,
  incidentReason: 'control_channel_closed',
  waitingFor: 'control-reattachment',
} as const;

function isBackendHealth(value: unknown): boolean {
  return parseBackendHealth(value) !== null;
}

describe('/health typed shape (AC10a)', () => {
  it('accepts a healthy shape with one online component and no diagnostics', () => {
    expect(isBackendHealth(HEALTHY_BASE)).toBe(true);
  });

  it('accepts an empty components array', () => {
    expect(isBackendHealth({ ...HEALTHY_BASE, components: [] })).toBe(true);
  });

  it('accepts only a redacted named system provider scope', () => {
    expect(
      isBackendHealth({
        ...HEALTHY_BASE,
        systemProviderScope: { name: 'maintenance', providers: ['claude', 'codex'] },
      }),
    ).toBe(true);
    expect(
      isBackendHealth({
        ...HEALTHY_BASE,
        systemProviderScope: { name: '', providers: ['/private/profile'] },
      }),
    ).toBe(false);
  });

  it('accepts an initializing component with attempt count', () => {
    const initializing: BackendHealth = {
      ...HEALTHY_BASE,
      components: [{ id: 'kb', phase: 'initializing', attempt: 2 }],
    };
    expect(isBackendHealth(initializing)).toBe(true);
  });

  it('accepts a degraded component with curate-publish reason', () => {
    const degraded: BackendHealth = {
      ...HEALTHY_BASE,
      components: [
        {
          id: 'kb',
          phase: 'degraded',
          reason: { kind: 'curate-publish', consecutiveFailures: 3, lastError: 'publish timed out' },
        },
      ],
    };
    expect(isBackendHealth(degraded)).toBe(true);
  });

  it('accepts a degraded recovery component with a quarantine count', () => {
    const degraded: BackendHealth = {
      ...HEALTHY_BASE,
      components: [
        {
          id: 'recovery',
          phase: 'degraded',
          reason: { kind: 'recovery-quarantine', count: 2, lastError: 'workflow hydration failed' },
        },
      ],
    };
    expect(isBackendHealth(degraded)).toBe(true);
  });

  it('accepts an offline component with reason and last log line', () => {
    const offline: BackendHealth = {
      ...HEALTHY_BASE,
      components: [
        { id: 'kb', phase: 'offline', reason: 'init failed', lastLogLine: '[component:kb] catalog scan failed' },
      ],
    };
    expect(isBackendHealth(offline)).toBe(true);
  });

  it('accepts an offline component diagnostic with boot failure context', () => {
    const offline: BackendHealth = {
      ...HEALTHY_BASE,
      components: [
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
          { id: 'vector-base', authority: 'journal', cursor: 42, elapsedSinceStopMs: 100 },
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

  it.each([
    { coverage: 'complete', liveJobs: 2, unknownJobs: 1, recoveryDefectJobs: 1 },
    { coverage: 'unknown', liveJobs: 0, unknownJobs: 3, recoveryDefectJobs: 0 },
  ] as const)('accepts carrier diagnostics with $coverage coverage', (carriers) => {
    expect(isBackendHealth({ ...HEALTHY_BASE, diagnostics: { carriers } })).toBe(true);
  });

  it.each([
    ['a malformed token', 'pps2.future'],
    [
      'a token for a different identity',
      encodeProviderProxySetAddress({
        ...PROVIDER_PROXY_SET.setIdentity,
        proxyInstanceId: '33333333-3333-4333-8333-333333333333',
      }),
    ],
  ])('skips %s without publishing it as an actionable command token', (_label, setToken) => {
    const parsed = parseBackendHealth({
      ...HEALTHY_BASE,
      diagnostics: { providerProxySets: [{ ...PROVIDER_PROXY_SET, setToken }] },
    });

    expect(parsed).toEqual({
      health: { ...HEALTHY_BASE, diagnostics: { providerProxySets: [] } },
      skippedProviderProxySetRows: 1,
      skippedProviderProxySetTokens: [],
    });
  });

  it.each([
    { coverage: 'partial', liveJobs: 1, unknownJobs: 0, recoveryDefectJobs: 0 },
    { coverage: 'complete', liveJobs: -1, unknownJobs: 0, recoveryDefectJobs: 0 },
    { coverage: 'complete', liveJobs: 1, unknownJobs: 0.5, recoveryDefectJobs: 0 },
    { coverage: 'unknown', liveJobs: 0, unknownJobs: 1 },
  ])('rejects malformed carrier diagnostics %#', (carriers) => {
    expect(isBackendHealth({ ...HEALTHY_BASE, diagnostics: { carriers } })).toBe(false);
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

  it('accepts KB daemon supervisor health', () => {
    const withKbDaemon: BackendHealth = {
      ...HEALTHY_BASE,
      kbDaemon: {
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
        daemonUptimeMs: 50,
        kbRead: {
          phase: 'ready',
          initializedAt: 1_700_000_000_055,
        },
        kbWrite: {
          phase: 'disposed',
          initializedAt: 1_700_000_000_056,
          curateRunning: false,
          mutationBlocked: { owner: 'reindex', ageMs: 5000, signaledAtMs: 1_700_000_000_057 },
        },
        lastExit: {
          code: 0,
          signal: null,
          at: 1_700_000_000_000,
          uptimeMs: 500,
        },
      },
    };
    expect(isBackendHealth(withKbDaemon)).toBe(true);
  });

  it('rejects malformed KB daemon supervisor health', () => {
    const malformed = {
      ...HEALTHY_BASE,
      kbDaemon: {
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

  it('rejects the retired `components.kb.kind` object shape (clean-slate cost)', () => {
    // The validator must fail-loud on that shape so the contract change
    // surfaces rather than silently parsing as a degenerate structure.
    const retired = {
      ...HEALTHY_BASE,
      components: { kb: { kind: 'ok' }, kbCurate: 'ok', discuss: 'ok' },
    };
    expect(isBackendHealth(retired)).toBe(false);
  });

  it('rejects an unknown phase string', () => {
    const malformed = { ...HEALTHY_BASE, components: [{ id: 'kb', phase: 'unavailable' }] };
    expect(isBackendHealth(malformed)).toBe(false);
  });

  it('rejects a degraded component missing the reason object', () => {
    const malformed = { ...HEALTHY_BASE, components: [{ id: 'kb', phase: 'degraded' }] };
    expect(isBackendHealth(malformed)).toBe(false);
  });

  it('rejects a recovery quarantine reason with an invalid count or missing last error', () => {
    expect(
      isBackendHealth({
        ...HEALTHY_BASE,
        components: [
          {
            id: 'recovery',
            phase: 'degraded',
            reason: { kind: 'recovery-quarantine', count: -1, lastError: 'failed' },
          },
        ],
      }),
    ).toBe(false);
    expect(
      isBackendHealth({
        ...HEALTHY_BASE,
        components: [
          {
            id: 'recovery',
            phase: 'degraded',
            reason: { kind: 'recovery-quarantine', count: 1 },
          },
        ],
      }),
    ).toBe(false);
  });

  it('rejects a malformed offline component diagnostic', () => {
    const malformed = {
      ...HEALTHY_BASE,
      components: [
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

  it('rejects a negative offline component diagnostic attempt count', () => {
    const malformed = {
      ...HEALTHY_BASE,
      components: [
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

  it.each([
    ['disposition', 'released-by-successor'],
    ['cause', 'peer-generation-changed'],
    ['waitingFor', 'successor-acknowledgement'],
  ] as const)('skips a well-formed provider proxy set row with an unknown %s', (field, value) => {
    const parsed = parseBackendHealth({
      ...HEALTHY_BASE,
      diagnostics: {
        providerProxySets: [PROVIDER_PROXY_SET, { ...PROVIDER_PROXY_SET, [field]: value }],
      },
    });

    expect(parsed).toEqual({
      health: { ...HEALTHY_BASE, diagnostics: { providerProxySets: [PROVIDER_PROXY_SET] } },
      skippedProviderProxySetRows: 1,
      skippedProviderProxySetTokens: [PROVIDER_PROXY_SET.setToken],
    });
  });

  it("skips an unknown cause that does not carry this build's companion fields", () => {
    const future = {
      setIdentity: PROVIDER_PROXY_SET.setIdentity,
      setToken: PROVIDER_PROXY_SET.setToken,
      disposition: PROVIDER_PROXY_SET.disposition,
      cause: 'successor-adopted',
      incidentReason: PROVIDER_PROXY_SET.incidentReason,
      waitingFor: PROVIDER_PROXY_SET.waitingFor,
    };
    const parsed = parseBackendHealth({
      ...HEALTHY_BASE,
      diagnostics: { providerProxySets: [future] },
    });

    expect(parsed).toEqual({
      health: { ...HEALTHY_BASE, diagnostics: { providerProxySets: [] } },
      skippedProviderProxySetRows: 1,
      skippedProviderProxySetTokens: [PROVIDER_PROXY_SET.setToken],
    });
  });

  it('skips a row with a future enforcer observation without rejecting the health payload', () => {
    const parsed = parseBackendHealth({
      ...HEALTHY_BASE,
      diagnostics: {
        providerProxySets: [
          {
            ...PROVIDER_PROXY_SET,
            enforcerObservations: [
              { role: 'guardian', observation: 'paused' },
              { role: 'reaper', observation: 'absent' },
            ],
          },
        ],
      },
    });

    expect(parsed).toEqual({
      health: { ...HEALTHY_BASE, diagnostics: { providerProxySets: [] } },
      skippedProviderProxySetRows: 1,
      skippedProviderProxySetTokens: [PROVIDER_PROXY_SET.setToken],
    });
  });

  it('skips malformed provider proxy set rows but still rejects a non-array collection', () => {
    const parseWith = (providerProxySets: unknown) =>
      parseBackendHealth({ ...HEALTHY_BASE, diagnostics: { providerProxySets } });

    expect(parseWith('not-an-array')).toBeNull();
    expect(parseWith([{ ...PROVIDER_PROXY_SET, setIdentity: undefined }])).toEqual({
      health: { ...HEALTHY_BASE, diagnostics: { providerProxySets: [] } },
      skippedProviderProxySetRows: 1,
      skippedProviderProxySetTokens: [],
    });
    expect(parseWith([{ ...PROVIDER_PROXY_SET, attempts: '2' }])).toEqual({
      health: { ...HEALTHY_BASE, diagnostics: { providerProxySets: [] } },
      skippedProviderProxySetRows: 1,
      skippedProviderProxySetTokens: [PROVIDER_PROXY_SET.setToken],
    });
    expect(parseWith([{ ...PROVIDER_PROXY_SET, disposition: 'released-by-successor', attempts: '2' }])).toEqual({
      health: { ...HEALTHY_BASE, diagnostics: { providerProxySets: [] } },
      skippedProviderProxySetRows: 1,
      skippedProviderProxySetTokens: [PROVIDER_PROXY_SET.setToken],
    });
  });
});
