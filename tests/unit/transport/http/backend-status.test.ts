// `getBackendStatusFull` has two independent ways to fail to reach an answer, and for a while both arrived as
// `not_running` — a status an operator reads as "nothing is there, start one".
//
// The process axis was split first: only an observed `'absent'` reports not-running. The record axis was
// missed, because both consumers reach it through `readBackendInfo`, whose `null` covers a missing file, an
// undecodable one, *and* a record lacking `version`/`instanceId`. So a `coordinator.json` truncated mid-write,
// or written by a build whose shape this one rejects, reported a confident absence while a coordinator was
// serving on the socket.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BackendInfo } from '#src/infra/backend-discovery.js';
import type { CoordinatorObservation } from '#src/transport/http/backend/coordinator-observation.js';
import { reserveRefusedPort } from '../../../fixtures/refused-port.js';

const NOW = 1_700_000_000_000;

const mockState = vi.hoisted(() => ({
  observed: { kind: 'no-record' } as CoordinatorObservation,
  /** The startup diagnostic on disk, or `null` for none. */
  diagnostic: null as string | null,
}));

// Mocked at the seam this function depends on. `status` and `shutdown` ask the same three questions about the
// coordinator, and driving them through two lower mocks meant each test file re-assembled that prelude itself
// — two fixtures for one observation, which is the duplication the production split removed.
vi.mock('#src/transport/http/backend/coordinator-observation.js', () => ({
  observeCoordinator: vi.fn(() => mockState.observed),
}));

vi.mock('#src/infra/bundle-manifest.js', () => ({
  readBuildFlavor: vi.fn(() => 'prod'),
}));

vi.mock('#src/runtime/real.js', () => ({
  createRealRuntime: vi.fn(() => ({
    storage: {
      readFileSync: () => {
        if (mockState.diagnostic === null) throw Object.assign(new Error('no diagnostic'), { code: 'ENOENT' });
        return mockState.diagnostic;
      },
    },
    env: {},
    time: { now: () => 1_700_000_000_000 },
    paths: {
      coral: {
        coordinator: { startupDiagnosticFile: '/tmp/coral-startup.json', infoFile: '/run/coral/coordinator.json' },
      },
    },
  })),
}));

function backendInfo(overrides: Partial<BackendInfo> = {}): BackendInfo {
  return {
    pid: 12345,
    port: 4321,
    host: '127.0.0.1',
    socketPath: '/tmp/coral.sock',
    token: 'backend-token',
    bootToken: 'boot-token',
    version: '0.0.0',
    bundleHash: 'bundle-hash',
    flavor: 'prod',
    namespace: 'test-namespace',
    instanceId: 'test-instance',
    startedAt: 1,
    ...overrides,
  };
}

describe('getBackendStatusFull record disposition', () => {
  beforeEach(() => {
    mockState.observed = { kind: 'no-record' };
    mockState.diagnostic = null;
  });

  // `vi.stubGlobal` replaces a process-wide binding, so cleanup cannot live at the tail of each test: an
  // assertion that throws skips it, and a test that stubs without a tail call leaks its `fetch` into whatever
  // runs next.
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reports not_running when the record is genuinely missing', async () => {
    const { getBackendStatusFull } = await import('#src/transport/http/backend/status.js');

    await expect(getBackendStatusFull('/plugin-root')).resolves.toEqual({ status: 'not_running' });
  });

  // A missing record alone used to report `not_running` unconditionally — including for a coordinator caught
  // between binding its IPC socket and publishing this discovery record (`observeCoordinator`'s
  // `no-record-socket-present`). That window must not read as a confident absence.
  it('reports no_record_socket_present, not not_running, when the coordinator socket exists without a record', async () => {
    mockState.observed = { kind: 'no-record-socket-present', socketPath: '/tmp/coral.sock' };

    const { getBackendStatusFull } = await import('#src/transport/http/backend/status.js');

    await expect(getBackendStatusFull('/plugin-root')).resolves.toEqual({
      status: 'no_record_socket_present',
      socketPath: '/tmp/coral.sock',
    });
  });

  // A socket close that exceeds the drain budget can outlive the record's removal, so a fresh startup
  // diagnostic can exist in this exact window too — and reporting the vague evidence instead of it would
  // discard the authored remediation for a genuine coordinator failure.
  it('reports recent_failure, not no_record_socket_present, when a fresh startup diagnostic explains the socket', async () => {
    mockState.observed = { kind: 'no-record-socket-present', socketPath: '/tmp/coral.sock' };
    mockState.diagnostic = startupDiagnostic(NOW - 10_000, 4242);

    const { getBackendStatusFull } = await import('#src/transport/http/backend/status.js');

    await expect(getBackendStatusFull('/plugin-root')).resolves.toMatchObject({
      status: 'recent_failure',
      phase: 'startup_failed',
    });
  });

  // Same fields, same omission, same wrong answer as the shutdown path: `readBackendInfo` returns `null` when
  // `version` or `instanceId` is absent, and nothing here reads either — the version an operator sees is the
  // one in the health response.
  it('does not report a pre-version incumbent as not running', async () => {
    const { version: _v, instanceId: _i, ...preVersion } = backendInfo();
    mockState.observed = { kind: 'addressed', coordinator: preVersion, pidLiveness: 'alive' };
    const fetchMock = vi.fn(async () => new Response('{}', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);

    const { getBackendStatusFull } = await import('#src/transport/http/backend/status.js');
    const result = await getBackendStatusFull('/plugin-root');

    // What this change establishes: the daemon is asked at all. Before it, `readBackendInfo` answered `null`
    // for this record and the function short-circuited to a not-running report without dialling anything.
    expect(fetchMock, 'the record carries host, port and bootToken, so the daemon can be asked').toHaveBeenCalled();
    // And the answer is now `unreachable` rather than `not_running`: the 500 came from something listening at
    // the recorded address.
    expect(result.status).toBe('unreachable');
  });

  // A peer identifying as another namespace really is not this backend; a bad response and a dead request are
  // not absence at all.
  it('reports a coordinator that answers badly as unreachable, not as stopped', async () => {
    mockState.observed = { kind: 'addressed', coordinator: backendInfo(), pidLiveness: 'alive' };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 500 })),
    );

    const { getBackendStatusFull } = await import('#src/transport/http/backend/status.js');

    await expect(getBackendStatusFull('/plugin-root')).resolves.toMatchObject({ status: 'unreachable' });
  });

  // The payload here must actually pass `isBackendPing` — it needs `version`, `bundleHash`, `instanceId` and
  // `pid` alongside the foreign `namespace`. A payload missing those fails the shape check first, so the `||`
  // in `probeUnauthenticatedPing` used to short-circuit before the namespace comparison ever ran, and this
  // test passed for a reason it did not describe.
  it('still reports not_running for a peer whose namespace says it is not this backend', async () => {
    mockState.observed = { kind: 'addressed', coordinator: backendInfo(), pidLiveness: 'alive' };
    const foreignPing = { ...JSON.parse(ping('ok')), namespace: 'someone-else' } as Record<string, unknown>;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(foreignPing), { status: 200 })),
    );

    const { getBackendStatusFull } = await import('#src/transport/http/backend/status.js');

    await expect(getBackendStatusFull('/plugin-root')).resolves.toEqual({ status: 'not_running' });
  });

  // `probeUnauthenticatedPing`'s guard is `namespace !== ... || flavor !== ...`: a namespace-only mismatch
  // exercises just the left side. Deleting `|| body.flavor !== info.flavor` left this suite green until this
  // test existed, because nothing sent a body agreeing on namespace and disagreeing only on flavor.
  it('reports not_running for a peer whose flavor disagrees, even with a matching namespace', async () => {
    mockState.observed = { kind: 'addressed', coordinator: backendInfo(), pidLiveness: 'alive' };
    const foreignFlavorPing = { ...JSON.parse(ping('ok')), flavor: 'dev' } as Record<string, unknown>;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(foreignFlavorPing), { status: 200 })),
    );

    const { getBackendStatusFull } = await import('#src/transport/http/backend/status.js');

    await expect(getBackendStatusFull('/plugin-root')).resolves.toEqual({ status: 'not_running' });
  });

  // This is the payload the test above used to send: it fails `isBackendPing` (no `version`, `bundleHash`,
  // `instanceId`, or `pid`), so it is a shape rejection, not a namespace disagreement — and proves nothing
  // about whose coordinator answered. Must not fall into `notOurCoordinator`'s `not_running`.
  it('reports unreachable, not not_running, for a 200 ping body this build cannot decode', async () => {
    mockState.observed = { kind: 'addressed', coordinator: backendInfo(), pidLiveness: 'alive' };
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ status: 'ok', namespace: 'someone-else', flavor: 'prod' }), { status: 200 }),
      ),
    );

    const { getBackendStatusFull } = await import('#src/transport/http/backend/status.js');

    await expect(getBackendStatusFull('/plugin-root')).resolves.toMatchObject({
      status: 'unreachable',
      cause: 'responded',
    });
  });

  it.each([['corrupt-json'], ['shape-rejected']] as const)(
    'reports the %s record as its own status, not as an absent coordinator',
    async (reason) => {
      mockState.observed = { kind: 'unreadable-record', reason, path: '/run/coral/coordinator.json' };
      // The record-derived view is still populated here, so a consumer reading only that would fall through to
      // the liveness check and report `not_running` — the collapse this branch exists to stop.

      const { getBackendStatusFull } = await import('#src/transport/http/backend/status.js');

      await expect(getBackendStatusFull('/plugin-root')).resolves.toEqual({
        status: 'undecodable_record',
        reason,
        path: '/run/coral/coordinator.json',
      });
    },
  );
});

/** A well-formed startup diagnostic, so only the scoping fields under test decide whether it is accepted. */
function startupDiagnostic(recordedAt: number, pid: number): string {
  return JSON.stringify({
    schemaVersion: 1,
    state: 'stopped_with_diagnostic',
    retryable: false,
    phase: 'startup_failed',
    recordedAt: new Date(recordedAt).toISOString(),
    pid,
    error: { kind: 'other' },
  });
}

// An absent coordinator is the one case where a diagnostic is allowed to explain the absence, so it is also
// the one case where the wrong diagnostic becomes the reported cause. Two fields scope it and each admits
// something alone: a pid is reused by the OS, and a `startedAt` floor without a pid admits any run after it.
describe('getBackendStatusFull scopes a startup diagnostic to the coordinator that died', () => {
  const STARTED_AT = NOW - 100_000;
  const PID = 12_345;

  beforeEach(() => {
    mockState.observed = { kind: 'process-absent', pid: PID, startedAt: STARTED_AT };
  });

  it('reports a diagnostic recorded during this run', async () => {
    mockState.diagnostic = startupDiagnostic(STARTED_AT + 10_000, PID);

    const { getBackendStatusFull } = await import('#src/transport/http/backend/status.js');

    await expect(getBackendStatusFull('/plugin-root')).resolves.toMatchObject({
      status: 'recent_failure',
      phase: 'startup_failed',
    });
  });

  it('ignores one recorded before this coordinator started, even though the pid matches', async () => {
    // The recycled-pid case. Without the `startedAt` floor this reports a previous daemon's crash as the
    // explanation for a coordinator that exited cleanly minutes later.
    mockState.diagnostic = startupDiagnostic(STARTED_AT - 10_000, PID);

    const { getBackendStatusFull } = await import('#src/transport/http/backend/status.js');

    await expect(getBackendStatusFull('/plugin-root')).resolves.toEqual({ status: 'not_running' });
  });

  it('ignores one recorded during this run by a different pid', async () => {
    mockState.diagnostic = startupDiagnostic(STARTED_AT + 10_000, PID + 1);

    const { getBackendStatusFull } = await import('#src/transport/http/backend/status.js');

    await expect(getBackendStatusFull('/plugin-root')).resolves.toEqual({ status: 'not_running' });
  });
});

/** A `/health` ping body this build accepts, so only the field under test decides the outcome. */
function ping(status: 'starting' | 'ok' | 'draining'): string {
  return JSON.stringify({
    status,
    version: '0.0.0',
    bundleHash: 'bundle-hash',
    flavor: 'prod',
    instanceId: 'test-instance',
    namespace: 'test-namespace',
    pid: 12345,
  });
}

/** The authenticated `/health?detailed=1` body, likewise minimal-but-accepted. */
function detailed(status: 'starting' | 'ok' | 'draining'): string {
  return JSON.stringify({
    status,
    kernel: { phase: 'running', readyAt: 1_699_999_000_000 },
    version: '0.0.0',
    bundleHash: 'bundle-hash',
    flavor: 'prod',
    instanceId: 'test-instance',
    namespace: 'test-namespace',
    uptimeMs: 1_000,
    active: 0,
    activeJobs: 0,
    inflightRequests: 0,
    queueDepth: 0,
    textProjectionState: 'idle',
    components: [],
  });
}

/** Answers the two probes in order: the unauthenticated ping, then the detailed one. */
function stubProbes(...responses: readonly Response[]): ReturnType<typeof vi.fn> {
  const queue = [...responses];
  const mock = vi.fn(async () => queue.shift() ?? new Response('{}', { status: 500 }));
  vi.stubGlobal('fetch', mock);
  return mock;
}

// `backend status` is the operator's primary diagnostic, and this branch exists to stop it collapsing
// "stopped", "draining", "not ours" and "could not reach" into one another.
describe('getBackendStatusFull maps each answer to the word that describes it', () => {
  beforeEach(() => {
    mockState.observed = { kind: 'addressed', coordinator: backendInfo(), pidLiveness: 'alive' };
  });

  // Unlike the first `describe` in this file, none of the tests below restored `fetch` on their own —
  // `vi.stubGlobal` is a process-wide replacement, so a stub any of them left behind would leak into whatever
  // ran next. Same reasoning as the note on the first `describe`'s `afterEach`.
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reports a draining ping as shutting_down without asking the detailed probe', async () => {
    const fetchMock = stubProbes(new Response(ping('draining'), { status: 200 }));

    const { getBackendStatusFull } = await import('#src/transport/http/backend/status.js');

    await expect(getBackendStatusFull('/plugin-root')).resolves.toEqual({ status: 'shutting_down' });
    expect(fetchMock, 'the ping settled it; asking again could only disagree').toHaveBeenCalledTimes(1);
  });

  // 502/503/504 only: `TransientHttpError.isTransientStatus` is deliberately narrow, and 429 is *not* in it —
  // measured rather than assumed, after this table first guessed otherwise.
  it.each([[503], [502], [504]])('reports a %s ping as shutting_down, not as unreachable', async (status) => {
    stubProbes(new Response('{}', { status }));

    const { getBackendStatusFull } = await import('#src/transport/http/backend/status.js');

    await expect(getBackendStatusFull('/plugin-root')).resolves.toEqual({ status: 'shutting_down' });
  });

  it('reports a healthy detailed answer as ok, carrying the payload the operator reads', async () => {
    stubProbes(new Response(ping('ok'), { status: 200 }), new Response(detailed('ok'), { status: 200 }));

    const { getBackendStatusFull } = await import('#src/transport/http/backend/status.js');
    const result = await getBackendStatusFull('/plugin-root');

    expect(result.status).toBe('ok');
    expect(result, 'the version an operator sees comes from the daemon, not the record').toMatchObject({
      health: { status: 'ok', version: '0.0.0', instanceId: 'test-instance', uptimeMs: 1_000 },
    });
  });

  it('keeps a detailed answer usable while carrying the count of provider proxy set rows it skipped', async () => {
    const understoodRow = {
      setIdentity: {
        buildSetId: '11111111-1111-4111-8111-111111111111',
        hostFingerprint: 'a'.repeat(64),
        proxyInstanceId: '22222222-2222-4222-8222-222222222222',
      },
      setToken: 'pps1.fixture',
      disposition: 'held',
      incidentReason: 'control_channel_reattaching',
      waitingFor: 'control-reattachment',
    };
    const forwardShapedDetailed = {
      ...JSON.parse(detailed('ok')),
      diagnostics: {
        providerProxySets: [understoodRow, { ...understoodRow, disposition: 'released-by-successor' }],
      },
    };
    stubProbes(
      new Response(ping('ok'), { status: 200 }),
      new Response(JSON.stringify(forwardShapedDetailed), { status: 200 }),
    );

    const { getBackendStatusFull } = await import('#src/transport/http/backend/status.js');

    await expect(getBackendStatusFull('/plugin-root')).resolves.toMatchObject({
      status: 'ok',
      health: {
        diagnostics: { providerProxySets: [understoodRow] },
        skippedProviderProxySetRows: 1,
        skippedProviderProxySetTokens: [understoodRow.setToken],
      },
    });
  });

  it('reports a detailed answer that says draining as shutting_down', async () => {
    stubProbes(new Response(ping('ok'), { status: 200 }), new Response(detailed('draining'), { status: 200 }));

    const { getBackendStatusFull } = await import('#src/transport/http/backend/status.js');

    await expect(getBackendStatusFull('/plugin-root')).resolves.toEqual({ status: 'shutting_down' });
  });

  it.each([[503], [502], [504]])('reports a %s detailed answer as shutting_down', async (status) => {
    stubProbes(new Response(ping('ok'), { status: 200 }), new Response('{}', { status }));

    const { getBackendStatusFull } = await import('#src/transport/http/backend/status.js');

    await expect(getBackendStatusFull('/plugin-root')).resolves.toEqual({ status: 'shutting_down' });
  });

  it('reports a 429 as unreachable, because the transient set is 502/503/504 and nothing else', async () => {
    stubProbes(new Response(ping('ok'), { status: 200 }), new Response('{}', { status: 429 }));

    const { getBackendStatusFull } = await import('#src/transport/http/backend/status.js');

    await expect(getBackendStatusFull('/plugin-root')).resolves.toMatchObject({ status: 'unreachable' });
  });

  it('reports a rejected boot token as unauthorized, which is neither stopped nor unreachable', async () => {
    stubProbes(new Response(ping('ok'), { status: 200 }), new Response('{}', { status: 401 }));

    const { getBackendStatusFull } = await import('#src/transport/http/backend/status.js');

    await expect(getBackendStatusFull('/plugin-root')).resolves.toEqual({ status: 'unauthorized' });
  });

  // `probeDetailedHealth`'s own not-our-coordinator branch had no test: every namespace-mismatch case above
  // exercised only the unauthenticated ping, which returns before the detailed probe is ever asked.
  it('reports not_running for a peer whose namespace disagrees only at the detailed probe', async () => {
    const foreignDetailed = { ...JSON.parse(detailed('ok')), namespace: 'someone-else' } as Record<string, unknown>;
    stubProbes(
      new Response(ping('ok'), { status: 200 }),
      new Response(JSON.stringify(foreignDetailed), { status: 200 }),
    );

    const { getBackendStatusFull } = await import('#src/transport/http/backend/status.js');

    await expect(getBackendStatusFull('/plugin-root')).resolves.toEqual({ status: 'not_running' });
  });

  // Same gap as the ping probe, one level down: `probeDetailedHealth`'s guard is also `namespace !== ... ||
  // flavor !== ...`, and nothing exercised the flavor-only side of it here either.
  it('reports not_running for a peer whose flavor disagrees only at the detailed probe', async () => {
    const foreignFlavorDetailed = { ...JSON.parse(detailed('ok')), flavor: 'dev' } as Record<string, unknown>;
    stubProbes(
      new Response(ping('ok'), { status: 200 }),
      new Response(JSON.stringify(foreignFlavorDetailed), { status: 200 }),
    );

    const { getBackendStatusFull } = await import('#src/transport/http/backend/status.js');

    await expect(getBackendStatusFull('/plugin-root')).resolves.toEqual({ status: 'not_running' });
  });

  // Same split as the ping probe: a detailed body this build cannot decode proves nothing about whose
  // coordinator answered, so it must not fall into `notOurCoordinator`'s `not_running`.
  it('reports unreachable, not not_running, for a 200 detailed body this build cannot decode', async () => {
    stubProbes(
      new Response(ping('ok'), { status: 200 }),
      new Response(JSON.stringify({ status: 'ok' }), { status: 200 }),
    );

    const { getBackendStatusFull } = await import('#src/transport/http/backend/status.js');

    await expect(getBackendStatusFull('/plugin-root')).resolves.toMatchObject({
      status: 'unreachable',
      cause: 'responded',
    });
  });

  // The `catch` in `getBackendStatusFull` had no test that ever made `fetch` itself reject — every existing
  // case resolved a `Response`, good or bad. `cause: 'no_response'` is the one thing this branch alone
  // produces for a plain failure: no response was received at all, so `formatBackendStatus` must not claim
  // anything is listening.
  it('reports unreachable with cause no_response when the probe request never completes', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('getaddrinfo ENOTFOUND coordinator.example');
      }),
    );

    const { getBackendStatusFull } = await import('#src/transport/http/backend/status.js');

    await expect(getBackendStatusFull('/plugin-root')).resolves.toEqual({
      status: 'unreachable',
      detail: 'getaddrinfo ENOTFOUND coordinator.example',
      cause: 'no_response',
    });
  });

  // The other half of `thrownErrnoCode`'s string check, and the half `backend status` renders on its own path:
  // an `AbortSignal.timeout` rejection is a `DOMException` whose `.code` is the *number* `23` (measured on Node
  // v26.3.1). `detail` is a string an operator reads, so a reader that took any `.code` would put `23` in a
  // sentence about their coordinator. Driven by a shaped rejection rather than a real timeout because the
  // subject is what the reader does with a numeric `code`, not how long a socket takes to give up.
  it('does not render a numeric DOMException code as the detail an operator reads', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw Object.assign(new Error('The operation was aborted due to timeout'), {
          name: 'TimeoutError',
          code: 23,
        });
      }),
    );

    const { getBackendStatusFull } = await import('#src/transport/http/backend/status.js');

    await expect(getBackendStatusFull('/plugin-root')).resolves.toEqual({
      status: 'unreachable',
      detail: 'The operation was aborted due to timeout',
      cause: 'no_response',
    });
  });

  // Node's `fetch` rejects a refused connection with a `TypeError` whose own `.message` is the generic "fetch
  // failed" and whose `.code` is `undefined`; the errno travels on `.cause` instead (same measurement as
  // `thrownErrnoCode` in `src/infra/error-format.ts`, and `backend-shutdown.test.ts`). Without unwrapping
  // `.cause`, this branch reported the generic message here while `backend shutdown` already reported the real
  // errno for the identical failure — one fact, two different words in two commands asking the same question.
  it('reports the errno from .cause rather than the generic fetch-failed message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw Object.assign(new TypeError('fetch failed'), {
          cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:4321'), { code: 'ECONNREFUSED' }),
        });
      }),
    );

    const { getBackendStatusFull } = await import('#src/transport/http/backend/status.js');

    await expect(getBackendStatusFull('/plugin-root')).resolves.toEqual({
      status: 'unreachable',
      detail: 'ECONNREFUSED',
      cause: 'refused',
      pidLiveness: 'alive',
      pid: 12345,
      recordPath: '/run/coral/coordinator.json',
    });
  });

  // Method requirement: a hand-built `Error` that happens to carry the shape the reader expects is exactly how
  // `socket_refused` went dead in `backend shutdown` (see `backend-shutdown.test.ts`'s own note on this). This
  // drives the real global `fetch` against a real closed socket instead of a fixture, so the assertion cannot
  // agree with a regression in the `.cause` unwrap.
  it('reports unreachable as refused against a real closed port, not a hand-built error', async () => {
    const port = await reserveRefusedPort();

    vi.unstubAllGlobals();
    mockState.observed = {
      kind: 'addressed',
      coordinator: backendInfo({ host: '127.0.0.1', port }),
      pidLiveness: 'alive',
    };

    const { getBackendStatusFull } = await import('#src/transport/http/backend/status.js');

    await expect(getBackendStatusFull('/plugin-root')).resolves.toEqual({
      status: 'unreachable',
      detail: 'ECONNREFUSED',
      cause: 'refused',
      pidLiveness: 'alive',
      pid: 12345,
      recordPath: '/run/coral/coordinator.json',
    });
  });
});
