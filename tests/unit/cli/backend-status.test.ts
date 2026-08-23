import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  registerBackendCommands,
  type BackendStatusCommandOperations,
  type StoreResetCommandOperations,
} from '#src/cli/commands/backend.js';
import { formatBackendStatus, formatHandoffContinuationReason } from '#src/cli/format/backend.js';
import type { HandoffContinuationReason } from '#src/coordinator/handoff-runner.js';
import type { HandoffRoutingStatusReadResult } from '#src/coordinator/handoff-routing-status.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';
import { createRecoveryComponent } from '#src/coordinator/runtime-components/recovery-component.js';
import { createRuntimeComponentRegistry } from '#src/coordinator/runtime-components/registry.js';
import { RecoveryQuarantineStore } from '#src/recovery/quarantine.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { applyBundledStoreSchema } from '#src/store/db.js';
import { isBackendHealth } from '#src/transport/http/backend/health.js';
import { statusFromStartupDiagnostic, type BackendStatusFull } from '#src/transport/http/backend/status.js';
import type { HealthSnapshot } from '#src/transport/server-ports.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';

const TEST_TIME = { now: () => Date.parse('2026-08-03T00:00:00.000Z') };

const storeReset: StoreResetCommandOperations = {
  list: () => ({ incidents: [] }),
  report: async () => {
    throw new Error('not used');
  },
  discard: async () => {
    throw new Error('not used');
  },
};

let stdout = '';
let stderr = '';

beforeEach(() => {
  stdout = '';
  stderr = '';
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    stdout += chunk.toString();
    return true;
  }) as typeof process.stdout.write);
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    stderr += chunk.toString();
    return true;
  }) as typeof process.stderr.write);
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe('backend status generation readiness', () => {
  it('prints the ignored-legacy-generation notice directly in the CLI', async () => {
    const status: BackendStatusCommandOperations = {
      inspectReadiness: () => ({
        kind: 'legacy-ignored',
        legacyPath: '/state/data',
        generatedPath: '/state/gen2/data',
        storedProductVersion: '0.9.16',
      }),
      getStatus: async () => ({ status: 'not_running' }),
      getLiveHandoffResult: () => null,
      getRoutingStatus: async () => ({ kind: 'absent' }),
    };
    const program = new Command();
    program.exitOverride();
    registerBackendCommands(program, { storeReset, backendStatus: status });

    await program.parseAsync(['node', 'coral-cli', 'backend', 'status']);

    expect(stderr).toBe(
      'Legacy Coral history remains at /state/data (stored Coral version 0.9.16) and is left untouched. This generation initializes its own state at /state/gen2/data.\n',
    );
    expect(stdout).toContain('Backend not running.');
  });

  it('prints a recent startup failure returned by the read-only status probe', async () => {
    const status: BackendStatusCommandOperations = {
      inspectReadiness: () => ({ kind: 'no-legacy' }),
      getStatus: async () => ({
        status: 'recent_failure',
        phase: 'startup_failed',
      }),
      getLiveHandoffResult: () => null,
      getRoutingStatus: async () => ({ kind: 'absent' }),
    };
    const program = new Command();
    program.exitOverride();
    registerBackendCommands(program, { storeReset, backendStatus: status });

    await program.parseAsync(['node', 'coral-cli', 'backend', 'status']);

    expect(stderr).toBe('');
    expect(stdout).toBe(
      [
        'Backend is not running after a recent coordinator failure.',
        'Phase: startup_failed',
        'Next step: inspect the coordinator log, fix the reported cause, then retry a coral-cli mutating command to relaunch it.',
        '',
      ].join('\n'),
    );
  });
});

describe('backend status live handoff disposition', () => {
  it('renders and exits 75 for a same-version incumbent from a different build set', async () => {
    const status: BackendStatusCommandOperations = {
      inspectReadiness: () => ({ kind: 'no-legacy' }),
      getStatus: async () => ({ status: 'not_running' }),
      getLiveHandoffResult: () => ({
        kind: 'run-current',
        reason: {
          kind: 'routing',
          basis: {
            kind: 'invoking-build-not-older',
            comparison: 'same-version',
            invoking: {
              version: '0.10.9',
              buildSetId: '123e4567-e89b-42d3-a456-426614174000',
              bundleHash: 'invoking-bundle',
              flavor: 'prod',
            },
            incumbent: {
              version: '0.10.9',
              buildSetId: '223e4567-e89b-42d3-a456-426614174000',
              bundleHash: 'incumbent-bundle',
              flavor: 'prod',
            },
          },
        },
      }),
      getRoutingStatus: async () => ({ kind: 'absent' }),
    };
    const program = new Command();
    program.exitOverride();
    registerBackendCommands(program, { storeReset, backendStatus: status });

    await program.parseAsync(['node', 'coral-cli', 'backend', 'status']);

    expect(stdout).toBe(
      [
        'Backend not running. Any coral-cli mutating command (or a Claude Code session start) relaunches it.',
        'Handoff: continuing current build — the CLI and running backend are both version 0.10.9 but come from different builds, so guarded operations will not proceed.',
        'Next step: run coral-cli backend shutdown, then rerun a mutating command to relaunch from this installation.',
        '',
      ].join('\n'),
    );
    expect(process.exitCode).toBe(75);
  });

  it('suppresses an informational same-build-set disposition', async () => {
    const status: BackendStatusCommandOperations = {
      inspectReadiness: () => ({ kind: 'no-legacy' }),
      getStatus: async () => ({ status: 'not_running' }),
      getLiveHandoffResult: () => ({
        kind: 'run-current',
        reason: {
          kind: 'routing',
          basis: {
            kind: 'same-build-set',
            buildSetId: '123e4567-e89b-42d3-a456-426614174000',
          },
        },
      }),
      getRoutingStatus: async () => ({ kind: 'absent' }),
    };
    const program = new Command();
    program.exitOverride();
    registerBackendCommands(program, { storeReset, backendStatus: status });

    await program.parseAsync(['node', 'coral-cli', 'backend', 'status']);

    expect(stdout).toBe(
      'Backend not running. Any coral-cli mutating command (or a Claude Code session start) relaunches it.\n',
    );
    expect(process.exitCode).toBe(0);
  });
});

describe('backend routing status', () => {
  it('renders an unresolved invocation ID and contributes exit 75 for an absent owner', async () => {
    const invocationId = '123e4567-e89b-42d3-a456-426614174000';
    const routingStatus: HandoffRoutingStatusReadResult = {
      kind: 'current',
      generation: 1,
      statuses: [
        {
          kind: 'unresolved',
          selection: {
            generation: 1,
            sequence: 1,
            eventId: 'event-1',
            invocationId,
            observedAt: '2026-08-03T00:00:00.000Z',
            eventKind: 'routing-selected',
            phase: 'selection',
            owner: { pid: 101, incarnation: testIncarnation(101) },
            disposition: {
              kind: 'continue-current',
              basis: { kind: 'same-build-set', buildSetId: '123e4567-e89b-42d3-a456-426614174000' },
            },
          },
          ownerLiveness: { kind: 'absent' },
        },
      ],
      retirementHistoryTruncated: {
        kind: 'retirement-history-truncated',
        expiredIdentityCount: 0,
        causes: {
          'selection-evicted-at-capacity': 0,
          'completed-pair-compaction': 0,
          'operator-resolved': 0,
        },
        minSelectionSequence: null,
        maxSelectionSequence: null,
        earliestSelectedAt: null,
        latestSelectedAt: null,
      },
    };
    const status: BackendStatusCommandOperations = {
      inspectReadiness: () => ({ kind: 'no-legacy' }),
      getStatus: async () => ({ status: 'not_running' }),
      getLiveHandoffResult: () => null,
      getRoutingStatus: async () => routingStatus,
    };
    const program = new Command();
    program.exitOverride();
    registerBackendCommands(program, { storeReset, backendStatus: status });

    await program.parseAsync(['node', 'coral-cli', 'backend', 'status']);

    expect(stdout).toContain(`Routing invocation ${invocationId}: unresolved; its recorded owner is absent.`);
    expect(stdout).toContain(`backend routing-status resolve --invocation ${invocationId}`);
    expect(process.exitCode).toBe(75);
  });
});

describe('handoff continuation remediation', () => {
  const cases: ReadonlyArray<{
    name: string;
    reason: HandoffContinuationReason;
    expected: string;
  }> = [
    {
      name: 'unresolved incumbent',
      reason: {
        kind: 'routing',
        basis: { kind: 'incumbent-unresolved', cause: 'health-shape-rejected' },
      },
      expected: [
        'Handoff: continuing current build — the incumbent coordinator could not be resolved because its authenticated health reply was not recognized.',
        'Next step: follow the daemon-status remediation above; do not proceed while coral-cli backend status exits 75.',
      ].join('\n'),
    },
    {
      name: 'draining incumbent',
      reason: {
        kind: 'routing',
        basis: { kind: 'incumbent-unusable', cause: 'draining' },
      },
      expected: [
        'Handoff: continuing current build — the incumbent coordinator is shutting down.',
        'Next step: wait for backend shutdown to finish, then retry.',
      ].join('\n'),
    },
    {
      name: 'invoking identity unavailable',
      reason: {
        kind: 'routing',
        basis: { kind: 'invoking-identity-unavailable', failure: 'adjacent_manifest_mismatch' },
      },
      expected: [
        'Handoff: continuing current build — this CLI does not match its bundle manifest.',
        'Next step: repair or reinstall this Coral bundle, then retry.',
      ].join('\n'),
    },
    {
      name: 'incumbent identity unavailable',
      reason: {
        kind: 'routing',
        basis: {
          kind: 'incumbent-identity-unavailable',
          incumbent: {
            version: '2.1.0',
            bundleHash: 'incumbent-bundle',
            flavor: 'prod',
            instanceId: 'incumbent-1',
          },
        },
      },
      expected: [
        'Handoff: continuing current build — incumbent 2.1.0 did not report a complete bundle identity.',
        'Next step: run coral-cli backend shutdown, then rerun a mutating command to relaunch from this installation.',
      ].join('\n'),
    },
    {
      name: 'same-version invoking build',
      reason: {
        kind: 'routing',
        basis: {
          kind: 'invoking-build-not-older',
          comparison: 'same-version',
          invoking: {
            version: '2.1.0',
            buildSetId: '123e4567-e89b-42d3-a456-426614174000',
            bundleHash: 'invoking-bundle',
            flavor: 'prod',
          },
          incumbent: {
            version: '2.1.0',
            buildSetId: '223e4567-e89b-42d3-a456-426614174000',
            bundleHash: 'incumbent-bundle',
            flavor: 'prod',
          },
        },
      },
      expected: [
        'Handoff: continuing current build — the CLI and running backend are both version 2.1.0 but come from different builds, so guarded operations will not proceed.',
        'Next step: run coral-cli backend shutdown, then rerun a mutating command to relaunch from this installation.',
      ].join('\n'),
    },
    {
      name: 'invalid incumbent target',
      reason: {
        kind: 'routing',
        basis: {
          kind: 'invalid-incumbent-target',
          evidence: {
            bundleDir: '/opt/coral-old',
            expectedManifest: null,
            failure: 'bundle-dir-unavailable',
          },
        },
      },
      expected: [
        'Handoff: continuing current build — the incumbent handoff target at /opt/coral-old is invalid because its bundle directory is unavailable.',
        'Next step: repair or reinstall the Coral installation at /opt/coral-old, then retry.',
      ].join('\n'),
    },
    {
      name: 'abandoned delegation',
      reason: { kind: 'handoff-abandoned', reason: 'stdout-drain-incomplete' },
      expected: [
        'Handoff: continuing current build — delegation was abandoned because stdout did not finish draining.',
        "Next step: retry; if stdout still does not drain, preserve the output and inspect the invoking process's stdout consumer.",
      ].join('\n'),
    },
  ];

  // Machine identifiers the formatter translates rather than prints. A raw one reaching this list is the
  // defect these strings were written to remove.
  const RAW_ENUM_TOKENS = [
    'health-shape-rejected',
    'health-request-failed',
    'unreadable-record',
    'identity-mismatch',
    'stdout-drain-incomplete',
    'embedded_identity_unavailable',
    'adjacent_manifest_unavailable',
    'adjacent_manifest_invalid',
    'adjacent_manifest_mismatch',
    'bundle-dir-not-canonical',
    'bundle-dir-unavailable',
    'expected-manifest-invalid',
  ];

  it.each(cases)('authors a next step for $name', ({ reason }) => {
    const rendered = formatHandoffContinuationReason(reason);

    expect(rendered).toContain('Next step:');
    expect(RAW_ENUM_TOKENS.filter((token) => rendered.includes(token))).toEqual([]);
  });
});

describe('backend status recovery quarantine propagation', () => {
  it('carries the canonical producer reason through HTTP validation into CLI output', () => {
    const db = newRawDatabase(':memory:');
    try {
      applyBundledStoreSchema(db, currentCoralStoreFormat());
      const quarantine = new RecoveryQuarantineStore(db, TEST_TIME);
      quarantine.upsert({
        boundary: 'workflow-recovery',
        subject: { key: 'workflow-1', revision: { kind: 'fingerprint', value: 'revision-1' } },
        state: 'active',
        stage: 'hydrate',
        errorMessage: 'failed to hydrate persisted workflow',
        detail: 'retained for operator retry',
      });
      const recovery = createRecoveryComponent(db);
      const produced = {
        status: 'ok',
        kernel: { phase: 'running', readyAt: 1_700_000_000_000 },
        version: '0.10.4',
        bundleHash: 'bundle-hash',
        flavor: 'prod',
        namespace: 'test-ns',
        instanceId: 'instance-1',
        pid: 4242,
        uptimeMs: 1_000,
        active: 0,
        activeJobs: 0,
        liveDiscuss: 0,
        queueDepth: 0,
        inflightRequests: 0,
        textProjectionState: 'idle',
        env: {},
        components: [recovery.status],
      } satisfies HealthSnapshot;

      expect(isBackendHealth(produced)).toBe(true);
      if (!isBackendHealth(produced)) throw new Error('expected the produced health snapshot to validate');
      const { namespace: _namespace, status: _status, ...health } = produced;
      const status = { status: 'ok', health: { ...health, status: 'ok' } } satisfies BackendStatusFull;

      expect(formatBackendStatus(status)).toContain(
        [
          '  recovery: degraded',
          '    reason: recovery-quarantine (1 unresolved row)',
          '    last error: failed to hydrate persisted workflow',
          '    hint: inspect quarantined recovery work: coral-cli backend recovery-quarantine list',
        ].join('\n'),
      );
    } finally {
      db.close();
    }
  });

  it('keeps backend status readable when the recovery database handle is closed', () => {
    const db = newRawDatabase(':memory:');
    applyBundledStoreSchema(db, currentCoralStoreFormat());
    const registry = createRuntimeComponentRegistry();
    registry.register(createRecoveryComponent(db));
    db.close();

    const produced = {
      status: 'ok',
      kernel: { phase: 'running', readyAt: 1_700_000_000_000 },
      version: '0.10.4',
      bundleHash: 'bundle-hash',
      flavor: 'prod',
      namespace: 'test-ns',
      instanceId: 'instance-1',
      pid: 4242,
      uptimeMs: 1_000,
      active: 0,
      activeJobs: 0,
      liveDiscuss: 0,
      queueDepth: 0,
      inflightRequests: 0,
      textProjectionState: 'idle',
      env: {},
      components: [...registry.list()],
    } satisfies HealthSnapshot;

    expect(isBackendHealth(produced)).toBe(true);
    if (!isBackendHealth(produced)) throw new Error('expected the produced health snapshot to validate');
    const { namespace: _namespace, status: _status, ...health } = produced;
    const status = { status: 'ok', health: { ...health, status: 'ok' } } satisfies BackendStatusFull;

    expect(formatBackendStatus(status)).toContain('  recovery: offline\n    reason: Status unavailable:');
  });
});

describe('backend startup diagnostic classification', () => {
  const now = Date.parse('2026-08-02T12:00:00.000Z');

  it('classifies a recent failure without returning serialized exception text', () => {
    expect(
      statusFromStartupDiagnostic(
        {
          schemaVersion: 1,
          phase: 'startup_failed',
          state: 'stopped_with_diagnostic',
          retryable: false,
          pid: 4242,
          recordedAt: '2026-08-02T11:59:30.000Z',
          attemptId: 'attempt-1',
          exitCode: 1,
          error: {
            message: 'Coordinator startup failed',
            stack: 'not printed',
            cause: {
              message: 'Job recovery failed',
              cause: { message: 'Could not hydrate job-42' },
            },
          },
        },
        now,
      ),
    ).toEqual({
      status: 'recent_failure',
      phase: 'startup_failed',
    });
  });

  it('carries the authored cause and remediation of a documented setup failure', () => {
    expect(
      statusFromStartupDiagnostic(
        {
          schemaVersion: 1,
          phase: 'startup_failed',
          state: 'stopped_with_diagnostic',
          retryable: false,
          pid: 4242,
          recordedAt: '2026-08-02T11:59:30.000Z',
          exitCode: 1,
          error: {
            kind: 'coral_setup_error',
            code: 'store_newer_incompatible',
            userMessage:
              'The current-generation store was written by newer Coral 0.11.0 and is incompatible with this build.',
            remediation:
              "Use Coral 0.11.0 to read this store, or run 'coral-cli backend store-reset discard --target gen2 --flavor prod'.",
            // Context is deliberately not forwarded: only the two rendered
            // strings are authored per code and safe to show.
            context: { flavor: 'prod', version: '0.11.0' },
          },
        },
        now,
      ),
    ).toEqual({
      status: 'recent_failure',
      phase: 'startup_failed',
      setupError: {
        code: 'store_newer_incompatible',
        userMessage:
          'The current-generation store was written by newer Coral 0.11.0 and is incompatible with this build.',
        remediation:
          "Use Coral 0.11.0 to read this store, or run 'coral-cli backend store-reset discard --target gen2 --flavor prod'.",
      },
    });
  });

  it('does not render credentials from a serialized diagnostic cause', async () => {
    const secret = 'sk-proj-secret-value';
    const classified = statusFromStartupDiagnostic(
      {
        schemaVersion: 1,
        phase: 'startup_failed',
        state: 'stopped_with_diagnostic',
        retryable: false,
        pid: 4242,
        recordedAt: '2026-08-02T11:59:30.000Z',
        attemptId: 'attempt-1',
        exitCode: 1,
        error: {
          message: 'Coordinator startup failed',
          cause: { message: `Provider rejected credential ${secret}` },
        },
      },
      now,
    );
    if (classified === null) throw new Error('expected recent startup failure');
    const status: BackendStatusCommandOperations = {
      inspectReadiness: () => ({ kind: 'no-legacy' }),
      getStatus: async () => classified,
      getLiveHandoffResult: () => null,
      getRoutingStatus: async () => ({ kind: 'absent' }),
    };
    const program = new Command();
    program.exitOverride();
    registerBackendCommands(program, { storeReset, backendStatus: status });

    await program.parseAsync(['node', 'coral-cli', 'backend', 'status']);

    expect(stdout).not.toContain(secret);
    expect(stdout).not.toContain('Provider rejected credential');
    expect(stdout).toContain('Next step: inspect the coordinator log');
  });

  it('treats a diagnostic left from days ago as a genuine absence', () => {
    expect(
      statusFromStartupDiagnostic(
        {
          schemaVersion: 1,
          phase: 'startup_failed',
          state: 'stopped_with_diagnostic',
          retryable: false,
          recordedAt: '2026-07-30T12:00:00.000Z',
          error: { message: 'old failure' },
        },
        now,
      ),
    ).toBeNull();
  });

  it('does not attribute a prior failure to a newer discovered daemon', () => {
    expect(
      statusFromStartupDiagnostic(
        {
          schemaVersion: 1,
          phase: 'startup_failed',
          state: 'stopped_with_diagnostic',
          retryable: false,
          recordedAt: '2026-08-02T11:59:30.000Z',
          error: { message: 'prior failure' },
        },
        now,
        Date.parse('2026-08-02T11:59:45.000Z'),
      ),
    ).toBeNull();
  });

  it('rejects a diagnostic whose pid differs from the discovered pid', () => {
    expect(
      statusFromStartupDiagnostic(
        {
          schemaVersion: 1,
          phase: 'startup_failed',
          state: 'stopped_with_diagnostic',
          retryable: false,
          pid: 5151,
          recordedAt: '2026-08-02T11:59:50.000Z',
          error: { message: 'new contender failed' },
        },
        now,
        Date.parse('2026-08-02T11:59:00.000Z'),
        4242,
      ),
    ).toBeNull();
  });
});
