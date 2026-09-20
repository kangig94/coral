import { describe, expect, expectTypeOf, it } from 'vitest';

import { parseBackendHealth, type BackendHealth } from '#src/transport/http/backend/health.js';
import type {
  AssertDispositionCausesCoverIncident,
  AssertIncidentCoversDispositionCauses,
} from '#src/coordinator/services/provider-proxy-authority-fault.js';
import { encodeProviderProxySetAddress } from '#src/provider-proxy/set-address.js';
import {
  SHUTDOWN_REMAINDER_FILESYSTEM_SUBJECT_MAX_LENGTH,
  SHUTDOWN_REMAINDER_SCAN_LIMIT,
  shutdownRemainderCleanupRefusal,
  shutdownRemainderFilesystemSubject,
} from '#src/infra/shutdown-remainder-record.js';
import {
  PROVIDER_PROXY_SET_OPERATOR_DISPOSITIONS,
  PROVIDER_PROXY_SET_OPERATOR_DISPOSITION_CAUSES,
  PROVIDER_PROXY_SET_OPERATOR_DISPOSITION_WAITING_FOR,
} from '#src/provider-proxy/operator-disposition-vocabulary.js';

it('enumerates exactly the disposition causes an incident can produce', () => {
  expectTypeOf<AssertDispositionCausesCoverIncident>().toEqualTypeOf<never>();
  expectTypeOf<AssertIncidentCoversDispositionCauses>().toEqualTypeOf<never>();
});

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

const PROVIDER_PROXY_SET_HOLD = {
  disposition: 'held',
  cause: 'closed',
  attempts: 2,
  elapsedMs: 500,
  boundMs: 23_000,
  incidentReason: 'control_channel_closed',
  waitingFor: 'control-reattachment',
} as const;

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
  liveClaims: 0,
  operatorExit: { kind: 'contain' },
  holds: [PROVIDER_PROXY_SET_HOLD],
} as const;

const UNSUPPORTED_PROVIDER_PROXY_SET_ROW = {
  reason: 'unsupported-row',
  setToken: PROVIDER_PROXY_SET.setToken,
  setIdentity: PROVIDER_PROXY_SET.setIdentity,
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

  it('accepts bounded shutdown remainder cleanup refusals with an overflow count', () => {
    const refusal = {
      subject: shutdownRemainderFilesystemSubject('corrupt.json'),
      cause: { kind: 'system-error', operation: 'delete', code: 'EACCES' },
    };
    expect(
      isBackendHealth({
        ...HEALTHY_BASE,
        shutdownRemainderCleanupRefusals: [refusal],
        unreportedShutdownRemainderCleanupRefusalCount: 3,
        uncheckedShutdownRemainderCleanupRefusalCount: 5,
      }),
    ).toBe(true);
  });

  it('omits one malformed cleanup refusal without rejecting unrelated health fields', () => {
    const refusal = {
      subject: shutdownRemainderFilesystemSubject('corrupt.json'),
      cause: { kind: 'system-error', operation: 'delete', code: 'EACCES' },
    };

    expect(
      parseBackendHealth({
        ...HEALTHY_BASE,
        shutdownRemainderCleanupRefusals: [refusal, { ...refusal, subject: 'not-a-subject' }],
        unreportedShutdownRemainderCleanupRefusalCount: 2,
      }),
    ).toEqual({
      health: {
        ...HEALTHY_BASE,
        shutdownRemainderCleanupRefusals: [refusal],
        unreportedShutdownRemainderCleanupRefusalCount: 2,
      },
      malformedShutdownRemainderCleanupRefusalRowCount: 1,
      skippedProviderProxySetRows: 0,
      skippedProviderProxySetTokens: [],
    });
  });

  it.each([{}, 7, { subject: 'not-a-refusal' }])(
    'attributes a malformed cleanup row without claiming an unlisted refusal (%j)',
    (candidate) => {
      const parsed = parseBackendHealth({
        ...HEALTHY_BASE,
        shutdownRemainderCleanupRefusals: [candidate],
      });

      expect(parsed?.health.shutdownRemainderCleanupRefusals).toEqual([]);
      expect(parsed?.health.unreportedShutdownRemainderCleanupRefusalCount).toBeUndefined();
      expect(parsed?.malformedShutdownRemainderCleanupRefusalRowCount).toBe(1);
    },
  );

  it.each([
    ['line feed', 'unsafe\n.json', 'unsafe\\u{A}.json'],
    ['delete control', 'unsafe\x7f.json', 'unsafe\\u{7F}.json'],
  ])('round-trips a producer refusal whose filename contains a %s', (_case, subject, expectedLabel) => {
    const refusal = shutdownRemainderCleanupRefusal(subject, 'delete', { code: 'EACCES' });

    expect(
      parseBackendHealth({
        ...HEALTHY_BASE,
        shutdownRemainderCleanupRefusals: [refusal],
      })?.health.shutdownRemainderCleanupRefusals,
    ).toEqual([
      {
        subject: { identity: expect.stringMatching(/^[a-f0-9]{64}$/u), label: expectedLabel },
        cause: { kind: 'system-error', operation: 'delete', code: 'EACCES' },
      },
    ]);
  });

  it('round-trips an absolute scan-directory refusal subject unchanged', () => {
    const refusal = shutdownRemainderCleanupRefusal('/run/coral/shutdown-remainder.v1', 'scan-directory', {
      code: 'EACCES',
    });

    expect(
      parseBackendHealth({
        ...HEALTHY_BASE,
        shutdownRemainderCleanupRefusals: [refusal],
      })?.health.shutdownRemainderCleanupRefusals,
    ).toEqual([refusal]);
  });

  it('rejects unbounded cleanup refusal collections or invalid unreported counts', () => {
    const refusal = {
      subject: shutdownRemainderFilesystemSubject('corrupt.json'),
      cause: { kind: 'system-error', operation: 'delete', code: 'EACCES' },
    };
    expect(
      isBackendHealth({
        ...HEALTHY_BASE,
        shutdownRemainderCleanupRefusals: Array.from({ length: SHUTDOWN_REMAINDER_SCAN_LIMIT + 1 }, () => refusal),
      }),
    ).toBe(false);
    expect(isBackendHealth({ ...HEALTHY_BASE, unreportedShutdownRemainderCleanupRefusalCount: -1 })).toBe(false);
    expect(isBackendHealth({ ...HEALTHY_BASE, uncheckedShutdownRemainderCleanupRefusalCount: -1 })).toBe(false);
    expect(
      isBackendHealth({
        ...HEALTHY_BASE,
        unreportedShutdownRemainderCleanupRefusalCount: Number.MAX_SAFE_INTEGER + 1,
      }),
    ).toBe(false);
  });

  it.each([
    { cause: { kind: 'system-error', operation: 'delete', code: 'EACCES\ninjected' } },
    { cause: { kind: 'system-error', operation: 'delete', code: 'NOT_A_SYSTEM_ERRNO' } },
    {
      subject: {
        identity: 'a'.repeat(64),
        label: 'x'.repeat(SHUTDOWN_REMAINDER_FILESYSTEM_SUBJECT_MAX_LENGTH + 1),
      },
    },
    { subject: { identity: 'a'.repeat(64), label: 'corrupt.json\ninjected' } },
  ])('counts an individually malformed cleanup refusal separately from unreported refusals', (override) => {
    const refusal = {
      subject: shutdownRemainderFilesystemSubject('corrupt.json'),
      cause: { kind: 'system-error', operation: 'delete', code: 'EACCES' },
      ...override,
    };

    expect(
      parseBackendHealth({
        ...HEALTHY_BASE,
        shutdownRemainderCleanupRefusals: [refusal],
      }),
    ).toEqual({
      health: { ...HEALTHY_BASE, shutdownRemainderCleanupRefusals: [] },
      malformedShutdownRemainderCleanupRefusalRowCount: 1,
      skippedProviderProxySetRows: 0,
      skippedProviderProxySetTokens: [],
    });
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

  it('decodes launch permit diagnostics and rejects a malformed entry', () => {
    const launchPermit = {
      reservationId: 'reservation-1',
      jobId: 'job-1',
      pool: 'default',
      provider: 'codex',
      holder: { kind: 'proxy-operation', operationId: 'operation-1' },
      executionOwner: { kind: 'provider-session', id: 'session-1' },
      heldForMs: 900_001,
    } as const;

    expect(
      parseBackendHealth({ ...HEALTHY_BASE, diagnostics: { launchPermits: [launchPermit] } })?.health.diagnostics
        ?.launchPermits,
    ).toEqual([launchPermit]);
    expect(
      parseBackendHealth({
        ...HEALTHY_BASE,
        diagnostics: { launchPermits: [{ ...launchPermit, holder: { kind: 'system-task' } }] },
      }),
    ).toBeNull();
    expect(
      parseBackendHealth({
        ...HEALTHY_BASE,
        diagnostics: {
          launchPermits: [
            {
              ...launchPermit,
              holder: { kind: 'local-execution', operationId: 'op-1' },
            },
          ],
        },
      }),
    ).toBeNull();
  });

  it('decodes settlement recording failures and rejects malformed evidence', () => {
    const report = {
      ...HEALTHY_BASE,
      diagnostics: {
        settlementRefusalRecordingFailures: [
          {
            jobId: 'job-settlement-failure',
            cause: 'claim-release-failed',
            error: 'quarantine database unavailable',
            observedAtMs: 123,
          },
          {
            jobId: 'job-reassigned-claim',
            cause: 'claim-already-reassigned',
            error: 'claim belongs to a successor',
            observedAtMs: 124,
          },
          {
            jobId: 'job-settled-unbound',
            operationId: 'operation-settled-unbound',
            cause: 'settled-unbound-status-persist-failed',
            error: 'durable status write failed',
            observedAtMs: 125,
          },
        ],
      },
    };
    expect(parseBackendHealth(report)?.health.diagnostics?.settlementRefusalRecordingFailures).toEqual(
      report.diagnostics.settlementRefusalRecordingFailures,
    );
    expect(
      parseBackendHealth({
        ...report,
        diagnostics: {
          settlementRefusalRecordingFailures: [
            { ...report.diagnostics.settlementRefusalRecordingFailures[0], observedAtMs: -1 },
          ],
        },
      }),
    ).toBeNull();
    expect(
      parseBackendHealth({
        ...report,
        diagnostics: {
          settlementRefusalRecordingFailures: [
            {
              jobId: 'job-settled-unbound',
              cause: 'settled-unbound-status-persist-failed',
              error: 'durable status write failed',
              observedAtMs: 125,
            },
          ],
        },
      }),
    ).toBeNull();
  });

  it('decodes non-release launch dispositions and rejects conflicting disposition data', () => {
    const launchReleaseDisposition = {
      reservationId: 'reservation-release-1',
      jobId: 'job-release-1',
      pool: 'default',
      provider: 'codex',
      attemptedHolder: { kind: 'local-execution' },
      disposition: {
        kind: 'transferred',
        pool: 'default',
        holder: { kind: 'proxy-operation', operationId: 'operation-successor' },
      },
      observedAtMs: 456,
    } as const;

    expect(
      parseBackendHealth({
        ...HEALTHY_BASE,
        diagnostics: { launchReleaseDispositions: [launchReleaseDisposition] },
      })?.health.diagnostics?.launchReleaseDispositions,
    ).toEqual([launchReleaseDisposition]);
    expect(
      parseBackendHealth({
        ...HEALTHY_BASE,
        diagnostics: {
          launchReleaseDispositions: [
            {
              ...launchReleaseDisposition,
              disposition: {
                kind: 'already-released',
                pool: 'default',
                holder: { kind: 'proxy-operation', operationId: 'operation-successor' },
              },
            },
          ],
        },
      }),
    ).toBeNull();
  });

  const providerOperationAdoptionRemedies = [
    { kind: 'restart-coordinator' },
    { kind: 'remote-settlement' },
    { kind: 'recovery-quarantine-discard', command: { kind: 'list' } },
    { kind: 'recovery-quarantine-clear', command: { kind: 'list' } },
    { kind: 'external-repair' },
  ] as const;

  it.each(providerOperationAdoptionRemedies)('decodes the $kind provider-operation adoption remedy', (remedy) => {
    const refusal = {
      triggerRecordKey: 'discarded-record-key',
      rowDisposition: 'discarded',
      releasedLaunchPermits: 0,
      recordKey: 'surviving-record-key',
      jobId: 'job-1',
      operationId: 'operation-1',
      proxyInstanceId: 'proxy-1',
      buildSetId: 'build-set-1',
      reason: 'the provider operation ownership path is not initialized',
      remedy,
      observedAtMs: 456,
    } as const;

    expect(
      parseBackendHealth({
        ...HEALTHY_BASE,
        diagnostics: { providerOperationAdoptionRefusals: [refusal] },
      })?.health.diagnostics?.providerOperationAdoptionRefusals,
    ).toEqual([refusal]);
  });

  it('rejects a provider-operation adoption refusal with an incomplete identity', () => {
    const refusal = {
      triggerRecordKey: 'discarded-record-key',
      rowDisposition: 'discarded',
      releasedLaunchPermits: 0,
      recordKey: 'surviving-record-key',
      jobId: 'job-1',
      operationId: 'operation-1',
      proxyInstanceId: 'proxy-1',
      buildSetId: 'build-set-1',
      reason: 'the provider operation ownership path is not initialized',
      remedy: { kind: 'remote-settlement' },
      observedAtMs: 456,
    } as const;

    expect(
      parseBackendHealth({
        ...HEALTHY_BASE,
        diagnostics: {
          providerOperationAdoptionRefusals: [{ ...refusal, recordKey: '' }],
        },
      }),
    ).toBeNull();
  });

  it('decodes holder-specific launch reclamation evidence and rejects mismatched authorization', () => {
    const reclamation = {
      reservationId: 'reservation-reclaimed-1',
      jobId: 'job-reclaimed-1',
      pool: 'default',
      provider: 'codex',
      holder: { kind: 'proxy-operation', operationId: 'operation-reclaimed-1' },
      heldForMs: 30_000,
      evidence: {
        kind: 'provider-operation-absent',
        operationId: 'operation-reclaimed-1',
        jobEvidence: { kind: 'job-terminal', phase: 'aborted' },
      },
      reclaimedAtMs: 789,
    } as const;

    expect(
      parseBackendHealth({
        ...HEALTHY_BASE,
        diagnostics: { launchReclamations: [reclamation] },
      })?.health.diagnostics?.launchReclamations,
    ).toEqual([reclamation]);
    expect(
      parseBackendHealth({
        ...HEALTHY_BASE,
        diagnostics: {
          launchReclamations: [
            {
              ...reclamation,
              evidence: {
                ...reclamation.evidence,
                jobEvidence: { kind: 'job-terminal', phase: 'running' },
              },
            },
          ],
        },
      }),
    ).toBeNull();
    expect(
      parseBackendHealth({
        ...HEALTHY_BASE,
        diagnostics: {
          launchReclamations: [{ ...reclamation, evidence: { kind: 'job-terminal', phase: 'aborted' } }],
        },
      }),
    ).toBeNull();
    expect(
      parseBackendHealth({
        ...HEALTHY_BASE,
        diagnostics: {
          launchReclamations: [
            {
              ...reclamation,
              evidence: { ...reclamation.evidence, operationId: 'different-operation' },
            },
          ],
        },
      }),
    ).toBeNull();
  });

  it.each([
    { coverage: 'complete', liveJobs: 2, unknownJobs: 1, recoveryDefectJobs: 1 },
    { coverage: 'unknown', liveJobs: 0, unknownJobs: 3, recoveryDefectJobs: 0 },
  ] as const)('accepts carrier diagnostics with $coverage coverage', (carriers) => {
    expect(isBackendHealth({ ...HEALTHY_BASE, diagnostics: { carriers } })).toBe(true);
  });

  it.each([
    { label: 'a malformed token', setToken: 'pps2.future', reason: 'invalid-token' as const },
    {
      label: 'a token for a different identity',
      setToken: encodeProviderProxySetAddress({
        ...PROVIDER_PROXY_SET.setIdentity,
        proxyInstanceId: '33333333-3333-4333-8333-333333333333',
      }),
      reason: 'token-identity-disagreement' as const,
    },
  ])('preserves raw candidate identity when it skips $label', ({ setToken, reason }) => {
    const parsed = parseBackendHealth({
      ...HEALTHY_BASE,
      diagnostics: { providerProxySets: [{ ...PROVIDER_PROXY_SET, setToken }] },
    });

    expect(parsed).toEqual({
      health: {
        ...HEALTHY_BASE,
        diagnostics: {
          providerProxySets: [],
          providerProxySetRowSkips: [{ reason, setToken, setIdentity: PROVIDER_PROXY_SET.setIdentity }],
        },
      },
      skippedProviderProxySetRows: 1,
      skippedProviderProxySetTokens: [setToken],
    });
  });

  it('preserves keyed durable disposition skips and their unavailable action', () => {
    const skip = {
      key: `provider-proxy-set-operator-disposition.v2:${PROVIDER_PROXY_SET.setToken}:future`,
      setToken: PROVIDER_PROXY_SET.setToken,
      unavailableAction: 'reconciliation-and-retirement' as const,
    };

    expect(
      parseBackendHealth({
        ...HEALTHY_BASE,
        diagnostics: { providerProxyDispositionSkips: [skip] },
      })?.health.diagnostics?.providerProxyDispositionSkips,
    ).toEqual([skip]);
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
    const invalid = { ...PROVIDER_PROXY_SET_HOLD, [field]: value };
    const parsed = parseBackendHealth({
      ...HEALTHY_BASE,
      diagnostics: {
        providerProxySets: [PROVIDER_PROXY_SET, { ...PROVIDER_PROXY_SET, holds: [invalid] }],
      },
    });

    expect(parsed).toEqual({
      health: {
        ...HEALTHY_BASE,
        diagnostics: {
          providerProxySets: [PROVIDER_PROXY_SET],
          providerProxySetRowSkips: [UNSUPPORTED_PROVIDER_PROXY_SET_ROW],
        },
      },
      skippedProviderProxySetRows: 1,
      skippedProviderProxySetTokens: [PROVIDER_PROXY_SET.setToken],
    });
  });

  it.each(PROVIDER_PROXY_SET_OPERATOR_DISPOSITIONS.map((disposition) => [disposition] as const))(
    'accepts every disposition the vocabulary currently defines: %s',
    (disposition) => {
      const parsed = parseBackendHealth({
        ...HEALTHY_BASE,
        diagnostics: {
          providerProxySets: [{ ...PROVIDER_PROXY_SET, holds: [{ ...PROVIDER_PROXY_SET_HOLD, disposition }] }],
        },
      });

      expect(parsed?.skippedProviderProxySetRows).toBe(0);
      expect(parsed?.health.diagnostics?.providerProxySets).toHaveLength(1);
    },
  );

  it.each(PROVIDER_PROXY_SET_OPERATOR_DISPOSITION_CAUSES.map((cause) => [cause] as const))(
    'accepts every cause the vocabulary currently defines: %s',
    (cause) => {
      const parsed = parseBackendHealth({
        ...HEALTHY_BASE,
        diagnostics: {
          providerProxySets: [{ ...PROVIDER_PROXY_SET, holds: [{ ...PROVIDER_PROXY_SET_HOLD, cause }] }],
        },
      });

      expect(parsed?.skippedProviderProxySetRows).toBe(0);
      expect(parsed?.health.diagnostics?.providerProxySets).toHaveLength(1);
    },
  );

  it.each(PROVIDER_PROXY_SET_OPERATOR_DISPOSITION_WAITING_FOR.map((waitingFor) => [waitingFor] as const))(
    'accepts every waitingFor the vocabulary currently defines: %s',
    (waitingFor) => {
      const parsed = parseBackendHealth({
        ...HEALTHY_BASE,
        diagnostics: {
          providerProxySets: [{ ...PROVIDER_PROXY_SET, holds: [{ ...PROVIDER_PROXY_SET_HOLD, waitingFor }] }],
        },
      });

      expect(parsed?.skippedProviderProxySetRows).toBe(0);
      expect(parsed?.health.diagnostics?.providerProxySets).toHaveLength(1);
    },
  );

  it.each([
    { kind: 'none' },
    { kind: 'gated', remainingMs: 1250 },
    { kind: 'contain' },
    { kind: 'refused', ground: 'enforcer-alive' },
    { kind: 'refused', ground: 'enforcer-unobservable' },
    { kind: 'refused', ground: 'recorded-group-unattributable' },
    { kind: 'refused', ground: 'signal-authorization-refused' },
    { kind: 'refused', ground: 'identity-unobservable' },
    { kind: 'refused', ground: 'store-unreadable' },
    { kind: 'refused', ground: 'representation-release-fatal' },
  ] as const)('accepts an asserted operator exit: $kind', (operatorExit) => {
    const parsed = parseBackendHealth({
      ...HEALTHY_BASE,
      diagnostics: { providerProxySets: [{ ...PROVIDER_PROXY_SET, operatorExit }] },
    });

    expect(parsed?.skippedProviderProxySetRows).toBe(0);
    expect(parsed?.health.diagnostics?.providerProxySets).toHaveLength(1);
  });

  it('skips a set without an asserted operator exit and reports its token', () => {
    const { operatorExit: _operatorExit, ...exitlessSet } = PROVIDER_PROXY_SET;
    const parsed = parseBackendHealth({
      ...HEALTHY_BASE,
      diagnostics: { providerProxySets: [exitlessSet] },
    });

    expect(parsed).toEqual({
      health: {
        ...HEALTHY_BASE,
        diagnostics: { providerProxySets: [], providerProxySetRowSkips: [UNSUPPORTED_PROVIDER_PROXY_SET_ROW] },
      },
      skippedProviderProxySetRows: 1,
      skippedProviderProxySetTokens: [PROVIDER_PROXY_SET.setToken],
    });
  });

  it('skips a set with an unknown operator exit', () => {
    const parsed = parseBackendHealth({
      ...HEALTHY_BASE,
      diagnostics: { providerProxySets: [{ ...PROVIDER_PROXY_SET, operatorExit: { kind: 'terminate' } }] },
    });

    expect(parsed).toEqual({
      health: {
        ...HEALTHY_BASE,
        diagnostics: { providerProxySets: [], providerProxySetRowSkips: [UNSUPPORTED_PROVIDER_PROXY_SET_ROW] },
      },
      skippedProviderProxySetRows: 1,
      skippedProviderProxySetTokens: [PROVIDER_PROXY_SET.setToken],
    });
  });

  it("skips an unknown cause that does not carry this build's companion fields", () => {
    const future = { ...PROVIDER_PROXY_SET_HOLD, cause: 'successor-adopted' };
    const parsed = parseBackendHealth({
      ...HEALTHY_BASE,
      diagnostics: { providerProxySets: [{ ...PROVIDER_PROXY_SET, holds: [future] }] },
    });

    expect(parsed).toEqual({
      health: {
        ...HEALTHY_BASE,
        diagnostics: { providerProxySets: [], providerProxySetRowSkips: [UNSUPPORTED_PROVIDER_PROXY_SET_ROW] },
      },
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
            holds: [
              {
                ...PROVIDER_PROXY_SET_HOLD,
                enforcerObservations: [
                  { role: 'guardian', observation: 'paused' },
                  { role: 'reaper', observation: 'absent' },
                ],
              },
            ],
          },
        ],
      },
    });

    expect(parsed).toEqual({
      health: {
        ...HEALTHY_BASE,
        diagnostics: { providerProxySets: [], providerProxySetRowSkips: [UNSUPPORTED_PROVIDER_PROXY_SET_ROW] },
      },
      skippedProviderProxySetRows: 1,
      skippedProviderProxySetTokens: [PROVIDER_PROXY_SET.setToken],
    });
  });

  it('skips malformed provider proxy set rows but still rejects a non-array collection', () => {
    const parseWith = (providerProxySets: unknown) =>
      parseBackendHealth({ ...HEALTHY_BASE, diagnostics: { providerProxySets } });

    expect(parseWith('not-an-array')).toBeNull();
    expect(parseWith([{ ...PROVIDER_PROXY_SET, setIdentity: undefined }])).toEqual({
      health: {
        ...HEALTHY_BASE,
        diagnostics: {
          providerProxySets: [],
          providerProxySetRowSkips: [
            { reason: 'malformed-row', setToken: PROVIDER_PROXY_SET.setToken, setIdentity: null },
          ],
        },
      },
      skippedProviderProxySetRows: 1,
      skippedProviderProxySetTokens: [PROVIDER_PROXY_SET.setToken],
    });
    expect(parseWith([{ ...PROVIDER_PROXY_SET, setToken: undefined }])).toEqual({
      health: {
        ...HEALTHY_BASE,
        diagnostics: {
          providerProxySets: [],
          providerProxySetRowSkips: [
            { reason: 'malformed-row', setToken: null, setIdentity: PROVIDER_PROXY_SET.setIdentity },
          ],
        },
      },
      skippedProviderProxySetRows: 1,
      skippedProviderProxySetTokens: [],
    });
    expect(parseWith([null])).toEqual({
      health: {
        ...HEALTHY_BASE,
        diagnostics: {
          providerProxySets: [],
          providerProxySetRowSkips: [{ reason: 'malformed-row', setToken: null, setIdentity: null }],
        },
      },
      skippedProviderProxySetRows: 1,
      skippedProviderProxySetTokens: [],
    });
    expect(parseWith([{ ...PROVIDER_PROXY_SET, holds: [{ ...PROVIDER_PROXY_SET_HOLD, attempts: '2' }] }])).toEqual({
      health: {
        ...HEALTHY_BASE,
        diagnostics: { providerProxySets: [], providerProxySetRowSkips: [UNSUPPORTED_PROVIDER_PROXY_SET_ROW] },
      },
      skippedProviderProxySetRows: 1,
      skippedProviderProxySetTokens: [PROVIDER_PROXY_SET.setToken],
    });
    expect(
      parseWith([
        {
          ...PROVIDER_PROXY_SET,
          holds: [{ ...PROVIDER_PROXY_SET_HOLD, disposition: 'released-by-successor', attempts: '2' }],
        },
      ]),
    ).toEqual({
      health: {
        ...HEALTHY_BASE,
        diagnostics: { providerProxySets: [], providerProxySetRowSkips: [UNSUPPORTED_PROVIDER_PROXY_SET_ROW] },
      },
      skippedProviderProxySetRows: 1,
      skippedProviderProxySetTokens: [PROVIDER_PROXY_SET.setToken],
    });
  });
});
