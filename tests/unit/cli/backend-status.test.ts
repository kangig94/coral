import { Command } from 'commander';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';

import {
  registerBackendCommands,
  type BackendStatusCommandOperations,
  type DirectProviderProxySetHolderStatus,
  type StoreResetCommandOperations,
} from '#src/cli/commands/backend.js';
import type { Runtime } from '#src/runtime/ports.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { releaseStoreReset } from '#src/store/operator-store-reset.js';
import {
  formatBackendStatus,
  formatHandoffContinuationReason,
  formatHandoffRoutingStatus,
  formatUnreadableProviderOperationDiscard,
} from '#src/cli/format/backend.js';
import { formatHandoffPublicationIncident } from '#src/cli/format/handoff-publication.js';
import type { SetupErrorAuthorIdentity } from '#src/runtime/errors.js';
import type {
  HandoffContinuationReason,
  HandoffPublicationIncident,
  LiveHandoffContinuationResult,
  LiveHandoffResult,
} from '#src/coordinator/handoff-routing/runner.js';
import {
  handoffRoutingRecordSchemaRegistry,
  handoffRoutingStatusStoreSchema,
  MAX_COMPLETED_HANDOFF_ROUTING_PAIRS,
  MAX_RETIREMENT_TOMBSTONES,
  type HandoffRoutingInvocationStatus,
  type HandoffRoutingStatusReadResult,
  type OwnerLiveness,
  type RetirementHistoryTruncated,
  type RetirementTombstone,
} from '#src/coordinator/handoff-routing/status.js';
import { incumbentIdentitySummarySchema, type HandoffRoutingBasis } from '#src/coordinator/handoff-routing/policy.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';
import { createRecoveryComponent } from '#src/coordinator/runtime-components/recovery-component.js';
import { createRuntimeComponentRegistry } from '#src/coordinator/runtime-components/registry.js';
import { RecoveryQuarantineStore } from '#src/recovery/quarantine.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { applyBundledStoreSchema } from '#src/store/db.js';
import { handoffRoutingStatusGeneration } from '#src/store/handoff-routing-status-store/index.js';
import { parseBackendHealth } from '#src/transport/http/backend/health.js';
import { statusFromStartupDiagnostic, type BackendStatusFull } from '#src/cli/backend-status.js';
import type { HealthSnapshot } from '#src/transport/server-ports.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { encodeProviderProxySetAddress } from '#src/provider-proxy/set-address.js';
import {
  PROVIDER_PROXY_SET_OPERATOR_EXIT_REFUSAL_GROUNDS,
  type ProviderProxySetOperatorExit,
} from '#src/provider-proxy/operator-disposition-vocabulary.js';
import { executeRenderedCommand, operatorArtifactLines } from '#tests/helpers/rendered-command.js';

const TEST_TIME = { now: () => Date.parse('2026-08-03T00:00:00.000Z') };
const HANDOFF_ROUTING_STATUS_GENERATION = handoffRoutingStatusGeneration(handoffRoutingStatusStoreSchema());
const PUBLICATION_INVOCATION_ID = '123e4567-e89b-42d3-a456-426614174000';

type RecordedBackendCommand =
  | Readonly<{ kind: 'status' | 'shutdown' | 'routing-status-discard' | 'recovery-quarantine-list' }>
  | Readonly<{ kind: 'routing-status-resolve'; invocationId: string; forceUnobservable: boolean }>
  | Readonly<{ kind: 'provider-proxy-set-contain' | 'provider-proxy-set-abandon'; token: string }>;

function backendCommandProgram(dispatched: RecordedBackendCommand[]): Command {
  const program = new Command();
  program.exitOverride();
  const backend = program.command('backend');
  backend.command('status').action(() => {
    dispatched.push({ kind: 'status' });
  });
  backend.command('shutdown').action(() => {
    dispatched.push({ kind: 'shutdown' });
  });
  const routingStatus = backend.command('routing-status');
  routingStatus.command('discard').action(() => {
    dispatched.push({ kind: 'routing-status-discard' });
  });
  routingStatus
    .command('resolve')
    .requiredOption('--invocation <id>')
    .option('--force-unobservable')
    .action((options: { invocation: string; forceUnobservable?: boolean }) => {
      dispatched.push({
        kind: 'routing-status-resolve',
        invocationId: options.invocation,
        forceUnobservable: options.forceUnobservable ?? false,
      });
    });
  backend
    .command('recovery-quarantine')
    .command('list')
    .action(() => {
      dispatched.push({ kind: 'recovery-quarantine-list' });
    });
  const providerProxySet = backend.command('provider-proxy-set');
  providerProxySet.command('contain <token>').action((token: string) => {
    dispatched.push({ kind: 'provider-proxy-set-contain', token });
  });
  providerProxySet.command('abandon <token>').action((token: string) => {
    dispatched.push({ kind: 'provider-proxy-set-abandon', token });
  });
  return program;
}

function liveHandoffResult(
  continuation: LiveHandoffContinuationResult,
  publicationIncidents: readonly HandoffPublicationIncident[] = [],
): LiveHandoffResult {
  return { continuation, publicationIncidents };
}

function runningStatusFromHealthPayload(payload: unknown): Extract<BackendStatusFull, { status: 'ok' }> {
  const parsed = parseBackendHealth(payload);
  if (parsed === null) throw new Error('expected the produced health snapshot to validate');
  const { namespace: _namespace, status: _status, shutdown: _shutdown, ...health } = parsed.health;
  return {
    status: 'ok',
    health: {
      ...health,
      status: 'ok',
      skippedProviderProxySetRows: parsed.skippedProviderProxySetRows,
      skippedProviderProxySetTokens: parsed.skippedProviderProxySetTokens,
    },
  };
}

type RunningBackendStatus = Extract<BackendStatusFull, { status: 'ok' }>;
type RunningBackendHealth = RunningBackendStatus['health'];
type RunningDiagnostics = NonNullable<RunningBackendHealth['diagnostics']>;

const BASE_RUNNING_HEALTH = {
  status: 'ok',
  kernel: { phase: 'running', readyAt: Date.parse('2026-08-03T00:00:00.000Z') },
  version: '0.10.9',
  bundleHash: 'bundle-hash',
  instanceId: 'instance-1',
  uptimeMs: 1_000,
  active: 0,
  activeJobs: 0,
  inflightRequests: 0,
  queueDepth: 0,
  textProjectionState: 'idle',
  components: [],
  skippedProviderProxySetRows: 0,
  skippedProviderProxySetTokens: [],
} as const satisfies RunningBackendHealth;

function runningBackendStatus(
  diagnostics: RunningDiagnostics,
  health: Partial<RunningBackendHealth> = {},
): RunningBackendStatus {
  return { status: 'ok', health: { ...BASE_RUNNING_HEALTH, ...health, diagnostics } };
}

function nextStepLines(output: string): string[] {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^next ?step\b/iu.test(line) || line.startsWith('nextStep='));
}

const storeReset: StoreResetCommandOperations = {
  list: () => ({ epochs: [], holders: [], residues: [], legacyIncidents: [], truncated: false }),
  report: async () => {
    throw new Error('not used');
  },
  discard: async () => {
    throw new Error('not used');
  },
  release: async () => {
    throw new Error('not used');
  },
};

const noDirectProviderProxySetHolders = async () => [] as const;

let stdout = '';
let stderr = '';
const storeResetRoots: string[] = [];

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
  for (const root of storeResetRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('backend store-reset discard output', () => {
  it('does not print the absolute store root', async () => {
    const program = new Command();
    program.exitOverride();
    registerBackendCommands(program, {
      storeReset: {
        ...storeReset,
        discard: async () => ({
          kind: 'discarded',
          target: 'gen2',
          flavor: 'prod',
          baseDir: '/sensitive/store/root',
          previousEpoch: '4',
          currentEpoch: '5',
        }),
      },
    });

    await program.parseAsync([
      'node',
      'coral-cli',
      'backend',
      'store-reset',
      'discard',
      '--target',
      'gen2',
      '--flavor',
      'prod',
    ]);

    expect(stdout).toBe('Discarded store epoch 4; initialized epoch 5.\n');
    expect(stdout).not.toContain('/sensitive/store/root');
  });
});

describe('backend store-reset release failures', () => {
  function programForRelease(runtime: Runtime, releaseSocket: () => Promise<void>): Command {
    const program = new Command();
    program.exitOverride();
    registerBackendCommands(program, {
      storeReset: {
        ...storeReset,
        release: (target, _flavor, epoch) =>
          releaseStoreReset({
            target,
            runtime,
            epoch,
            acquireSocketGuard: async () => ({ release: releaseSocket }),
          }),
      },
    });
    return program;
  }

  async function runRelease(program: Command): Promise<void> {
    await program.parseAsync([
      'node',
      'coral-cli',
      'backend',
      'store-reset',
      'release',
      '1',
      '--target',
      'gen2',
      '--flavor',
      'prod',
    ]);
  }

  it('does not label a raw generation-lock parent EACCES as a reporting failure', async () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'coral-release-cli-eacces-'));
    storeResetRoots.push(baseDir);
    const baseRuntime = createRealRuntime('prod', { baseDir });
    const runtime = {
      ...baseRuntime,
      storage: new Proxy(baseRuntime.storage, {
        get(subject, property, receiver) {
          if (property !== 'mkdirSync') return Reflect.get(subject, property, receiver) as unknown;
          return () => {
            throw Object.assign(new Error('generation lock parent creation refused'), { code: 'EACCES' });
          };
        },
      }),
    };

    await runRelease(programForRelease(runtime, async () => undefined));

    expect(stderr).toContain('Store-reset release failed. [code=store_reset_release_failed]');
    expect(stderr).not.toContain('Store-reset reporting failed');
    expect(process.exitCode).toBe(70);
  });

  it('does not label a throwing socket-lock release as a reporting failure', async () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'coral-release-cli-lock-release-'));
    storeResetRoots.push(baseDir);
    const runtime = createRealRuntime('prod', { baseDir });

    await runRelease(
      programForRelease(runtime, async () => {
        throw new Error('socket lock release failed');
      }),
    );

    expect(stderr).toContain('Store-reset release failed. [code=store_reset_release_failed]');
    expect(stderr).not.toContain('Store-reset reporting failed');
    expect(process.exitCode).toBe(70);
  });
});

describe('backend status generation readiness', () => {
  it.each([
    [{ kind: 'unreadable', reason: 'invalid-json' } as const, 'Routing status is unreadable (invalid-json).'],
    [{ kind: 'foreign-generation', generation: 2 } as const, 'Routing status generation 2 belongs to another address.'],
  ])('names discard as the successor for a durable routing-status hold', async (status, summary) => {
    const rendered = formatHandoffRoutingStatus(status) ?? '';
    expect(rendered).toBe(
      `${summary}\nRouting hold: run the discard command below.\ncommand=coral-cli backend routing-status discard`,
    );
    const dispatched: RecordedBackendCommand[] = [];
    await executeRenderedCommand(backendCommandProgram(dispatched), rendered, { label: 'command' });
    expect(dispatched).toEqual([{ kind: 'routing-status-discard' }]);
  });

  it('refuses discard after an undeterminable read and names a non-destructive successor', async () => {
    const rendered = formatHandoffRoutingStatus({ kind: 'undeterminable', cause: 'io-failed', errcode: 5 }) ?? '';
    expect(rendered).toBe(
      [
        'Routing status could not be read (io-failed, errcode 5).',
        'Routing hold: inspect backend status again without discarding. If this persists, repair the reported storage condition; discard is not permitted because this read did not establish a discardable classification.',
        'command=coral-cli backend status',
      ].join('\n'),
    );
    const dispatched: RecordedBackendCommand[] = [];
    await executeRenderedCommand(backendCommandProgram(dispatched), rendered, { label: 'command' });
    expect(dispatched).toEqual([{ kind: 'status' }]);
  });

  it('prints the ignored-legacy-generation notice directly in the CLI', async () => {
    const status: BackendStatusCommandOperations = {
      inspectReadiness: () => ({
        kind: 'legacy-ignored',
        legacyPath: '/state/data',
        generatedPath: '/state/gen2/data',
      }),
      getStatus: async () => ({ status: 'no_record_no_socket' }),
      getLiveHandoffResult: () => null,
      getRoutingStatus: async () => ({ kind: 'absent' }),
      readProviderProxySetHolderStatusDirect: noDirectProviderProxySetHolders,
    };
    const program = new Command();
    program.exitOverride();
    registerBackendCommands(program, { storeReset, backendStatus: status });

    await program.parseAsync(['node', 'coral-cli', 'backend', 'status']);

    expect(stderr).toBe(
      'Legacy Coral history remains at /state/data; its contents were not inspected or changed. This generation initializes its own state at /state/gen2/data.\n',
    );
    expect(stdout).toContain('No coordinator discovery record and no coordinator socket');
  });

  it('prints a recent startup failure returned by the read-only status probe', async () => {
    const status: BackendStatusCommandOperations = {
      inspectReadiness: () => ({ kind: 'no-legacy' }),
      getStatus: async () => ({
        status: 'recent_failure',
        phase: 'startup_failed',
        retryable: false,
      }),
      getLiveHandoffResult: () => null,
      getRoutingStatus: async () => ({ kind: 'absent' }),
      readProviderProxySetHolderStatusDirect: noDirectProviderProxySetHolders,
    };
    const program = new Command();
    program.exitOverride();
    registerBackendCommands(program, { storeReset, backendStatus: status });

    await program.parseAsync(['node', 'coral-cli', 'backend', 'status']);

    expect(stderr).toBe('');
    expect(stdout).toBe(
      [
        'Coral recorded a recent coordinator failure.',
        'Phase: startup_failed',
        'Retryable: no',
        'Next step: inspect the coordinator log, fix the reported cause, then retry a mutating Coral command; it attempts startup or handoff.',
        '',
      ].join('\n'),
    );
  });

  it('prints direct holder status when the backend status result is unreachable', async () => {
    const directHolderStatus: DirectProviderProxySetHolderStatus = {
      buildSetId: '11111111-1111-4111-8111-111111111111',
      hostFingerprint: 'a'.repeat(64),
      proxyInstanceId: '22222222-2222-4222-8222-222222222222',
      guardian: {
        kind: 'answered',
        status: {
          disposition: 'unobservable',
          phase: 'published',
          holder: {
            instanceId: '33333333-3333-4333-8333-333333333333',
            pid: 4100,
            incarnation: testIncarnation(4100),
          },
          controlEpoch: 1,
          transitionSequence: 2,
          changedAtMs: TEST_TIME.now(),
          enforcementHold: {
            kind: 'recorded-group-unattributable',
            attempts: 3,
            roleIdentity: { role: 'guardian', pid: 4200, incarnation: testIncarnation(4200) },
            retry: { state: 'scheduled', nextProbeAtMs: TEST_TIME.now() + 4_000 },
          },
        },
      },
      reaper: { kind: 'unreachable', reason: 'connection refused' },
    };
    const readProviderProxySetHolderStatusDirect = vi.fn(async () => [directHolderStatus]);
    const getLiveHandoffResult = vi.fn(() => null);
    const status: BackendStatusCommandOperations = {
      inspectReadiness: () => ({ kind: 'no-legacy' }),
      getStatus: async () => ({ status: 'unreachable', detail: 'request timed out', cause: 'no_response' }),
      getLiveHandoffResult,
      getRoutingStatus: async () => ({ kind: 'undeterminable', cause: 'io-failed', errcode: 5 }),
      readProviderProxySetHolderStatusDirect,
    };
    const program = new Command();
    program.exitOverride();
    registerBackendCommands(program, { storeReset, backendStatus: status });

    await program.parseAsync(['node', 'coral-cli', 'backend', 'status']);

    expect(readProviderProxySetHolderStatusDirect).toHaveBeenCalledOnce();
    expect(getLiveHandoffResult).toHaveBeenCalledOnce();
    expect(stderr).toBe('');
    expect(stdout).toContain('Backend state is unknown: the coordinator did not give a usable answer');
    expect(stdout).toContain('Routing status could not be read (io-failed, errcode 5).');
    expect(stdout).toContain('guardian: unobservable');
    expect(stdout).toContain('hold=recorded-group-unattributable attempts=3 role=guardian:4200@');
    expect(stdout).toContain('nextProbeAt=2026-08-03T00:00:04.000Z');
    expect(stdout).toContain('reaper:   unreachable (connection refused)');
    expect(stdout.indexOf('Backend state is unknown')).toBeLessThan(stdout.indexOf('set proxy='));
    expect(process.exitCode).toBe(75);
  });

  it('reports an answered draining coordinator as healthy and skips the no-coordinator holder dial', async () => {
    const readProviderProxySetHolderStatusDirect = vi.fn(async () => []);
    const status: BackendStatusCommandOperations = {
      inspectReadiness: () => ({ kind: 'no-legacy' }),
      getStatus: async () =>
        runningBackendStatus({}, { status: 'draining', kernel: { phase: 'draining', readyAt: null } }),
      getLiveHandoffResult: () => null,
      getRoutingStatus: async () => ({ kind: 'absent' }),
      readProviderProxySetHolderStatusDirect,
    };
    const program = new Command();
    program.exitOverride();
    registerBackendCommands(program, { storeReset, backendStatus: status });

    await program.parseAsync(['node', 'coral-cli', 'backend', 'status']);

    expect(stdout).toContain('Backend draining');
    expect(readProviderProxySetHolderStatusDirect).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(0);
  });

  it.each([{ status: 'no_record_no_socket' } as const, { status: 'recorded_process_absent', pid: 4242 } as const])(
    'renders a parked direct holder for coordinator-unavailable status $status',
    async (backendResult) => {
      const roleIdentity = { role: 'reaper' as const, pid: 4200, incarnation: testIncarnation(4200) };
      const directHolderStatus: DirectProviderProxySetHolderStatus = {
        buildSetId: '11111111-1111-4111-8111-111111111111',
        hostFingerprint: 'a'.repeat(64),
        proxyInstanceId: '22222222-2222-4222-8222-222222222222',
        guardian: { kind: 'unreachable', reason: 'connection refused' },
        reaper: {
          kind: 'answered',
          status: {
            disposition: 'unobservable',
            phase: 'published',
            holder: {
              instanceId: '33333333-3333-4333-8333-333333333333',
              pid: 4100,
              incarnation: testIncarnation(4100),
            },
            controlEpoch: 1,
            transitionSequence: 2,
            changedAtMs: TEST_TIME.now(),
            enforcementHold: {
              kind: 'reap-failed',
              reason: 'process-containment-reap-failed',
              attempts: 5,
              roleIdentity,
              retry: { state: 'operator-action-required' },
            },
          },
        },
      };
      const readProviderProxySetHolderStatusDirect = vi.fn(async () => [directHolderStatus]);
      const status: BackendStatusCommandOperations = {
        inspectReadiness: () => ({ kind: 'no-legacy' }),
        getStatus: async () => backendResult,
        getLiveHandoffResult: () => null,
        getRoutingStatus: async () => ({ kind: 'absent' }),
        readProviderProxySetHolderStatusDirect,
      };
      const program = new Command();
      program.exitOverride();
      registerBackendCommands(program, { storeReset, backendStatus: status });

      await program.parseAsync(['node', 'coral-cli', 'backend', 'status']);

      expect(readProviderProxySetHolderStatusDirect).toHaveBeenCalledOnce();
      expect(stdout).toContain(`set proxy=${directHolderStatus.proxyInstanceId}`);
      expect(stdout).toContain('operator-action-required');
      expect(stdout).toContain(
        `coral-cli backend provider-proxy-set retry-role-reap --role reaper --pid 4200 --incarnation '${testIncarnation(4200)}'`,
      );
      expect(process.exitCode).toBe(75);
    },
  );

  it('does not treat two departed holders as proof that provider containment is absent', async () => {
    const holder = {
      instanceId: '33333333-3333-4333-8333-333333333333',
      pid: 4100,
      incarnation: testIncarnation(4100),
    };
    const departed = {
      kind: 'answered' as const,
      status: {
        disposition: 'departed' as const,
        phase: 'published' as const,
        holder,
        controlEpoch: 1,
        transitionSequence: 2,
        changedAtMs: TEST_TIME.now(),
        enforcementHold: null,
      },
    };
    const directHolderStatus: DirectProviderProxySetHolderStatus = {
      buildSetId: '11111111-1111-4111-8111-111111111111',
      hostFingerprint: 'a'.repeat(64),
      proxyInstanceId: '22222222-2222-4222-8222-222222222222',
      guardian: departed,
      reaper: departed,
    };
    const readProviderProxySetHolderStatusDirect = vi.fn(async () => [directHolderStatus]);
    const status: BackendStatusCommandOperations = {
      inspectReadiness: () => ({ kind: 'no-legacy' }),
      getStatus: async () => ({ status: 'no_record_no_socket' }),
      getLiveHandoffResult: () => null,
      getRoutingStatus: async () => ({ kind: 'absent' }),
      readProviderProxySetHolderStatusDirect,
    };
    const program = new Command();
    program.exitOverride();
    registerBackendCommands(program, { storeReset, backendStatus: status });

    await program.parseAsync(['node', 'coral-cli', 'backend', 'status']);

    expect(readProviderProxySetHolderStatusDirect).toHaveBeenCalledOnce();
    expect(stdout).toContain('guardian: departed');
    expect(stdout).toContain('reaper:   departed');
    expect(process.exitCode).toBe(75);
  });
});

describe('backend status live handoff disposition', () => {
  it('renders and exits 75 for a same-version incumbent from a different build set', async () => {
    const status: BackendStatusCommandOperations = {
      inspectReadiness: () => ({ kind: 'no-legacy' }),
      getStatus: async () => ({ status: 'no_record_no_socket' }),
      readProviderProxySetHolderStatusDirect: noDirectProviderProxySetHolders,
      getLiveHandoffResult: () =>
        liveHandoffResult({
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
        'No coordinator discovery record and no coordinator socket at the current expected address were found. Any mutating Coral command (or a Claude Code session start) attempts startup.',
        'Handoff: continuing current build — the CLI and running backend are both version 0.10.9 but come from different builds, so guarded operations will not proceed.',
        'Handoff hold: run the shutdown command below, then rerun a mutating command; it attempts startup or handoff from this installation.',
        'command=coral-cli backend shutdown',
        '',
      ].join('\n'),
    );
    const dispatched: RecordedBackendCommand[] = [];
    await executeRenderedCommand(backendCommandProgram(dispatched), stdout, { label: 'command' });
    expect(dispatched).toEqual([{ kind: 'shutdown' }]);
    expect(process.exitCode).toBe(75);
  });

  it('suppresses an informational same-build-set disposition', async () => {
    const status: BackendStatusCommandOperations = {
      inspectReadiness: () => ({ kind: 'no-legacy' }),
      getStatus: async () => ({ status: 'no_record_no_socket' }),
      readProviderProxySetHolderStatusDirect: noDirectProviderProxySetHolders,
      getLiveHandoffResult: () =>
        liveHandoffResult({
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
      'No coordinator discovery record and no coordinator socket at the current expected address were found. Any mutating Coral command (or a Claude Code session start) attempts startup.\n',
    );
    expect(process.exitCode).toBe(0);
  });

  it('renders the live-incumbent newer-build line exactly', async () => {
    const status: BackendStatusCommandOperations = {
      inspectReadiness: () => ({ kind: 'no-legacy' }),
      getStatus: async () => ({ status: 'no_record_no_socket' }),
      readProviderProxySetHolderStatusDirect: noDirectProviderProxySetHolders,
      getLiveHandoffResult: () =>
        liveHandoffResult({
          kind: 'run-current',
          reason: {
            kind: 'routing',
            basis: {
              kind: 'invoking-build-not-older',
              comparison: 'newer-version',
              invoking: {
                version: '0.10.8',
                buildSetId: '123e4567-e89b-42d3-a456-426614174000',
                bundleHash: 'invoking-bundle',
                flavor: 'prod',
              },
              incumbent: {
                version: '0.10.6',
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

    expect(stdout).toContain(
      'Handoff: continuing current build — invoking build 0.10.8 is newer than incumbent 0.10.6.',
    );
  });
});

describe('backend status local exit combination', () => {
  it('renders the invalid-record validation category on the publication-incident surface', () => {
    const rendered = formatHandoffPublicationIncident({
      phase: 'selection',
      invocationId: PUBLICATION_INVOCATION_ID,
      kind: 'not-published',
      cause: 'invalid-record',
      validation: { kind: 'schema-violation' },
    });
    expect(rendered).toContain('invalid-record, schema-violation');
    expect(rendered).toContain(`invocation ${PUBLICATION_INVOCATION_ID}`);
    expect(rendered).toContain('After installing corrected Coral software, rerun coral-cli backend status');
  });

  it.each([
    ['contended', 'rerun coral-cli backend status'],
    ['generation-maintenance', 'maintenance lease has gone ten minutes without a heartbeat'],
    ['capacity-exhausted', 'repair the reported storage-capacity condition'],
    ['io-failed', 'repair the reported storage condition'],
    ['storage-corrupt', 'routing-status discard successor'],
    ['rejected-transition', 'do not assume publication occurred'],
    ['coordination-unavailable', 'make the generation coordination root writable again'],
  ] as const)('keeps the $0 prerequisite on a completed terminal publication incident', (cause, prerequisite) => {
    const rendered = formatHandoffPublicationIncident({
      phase: 'terminal',
      invocationId: PUBLICATION_INVOCATION_ID,
      terminalDisposition: {
        kind: 'continued-current',
        reason: { kind: 'routing', basis: { kind: 'incumbent-absent' } },
      },
      kind: 'not-published',
      cause,
    });

    expect(rendered).toContain(prerequisite);
    expect(rendered).toContain(`coral-cli backend routing-status resolve --invocation ${PUBLICATION_INVOCATION_ID}`);
    expect(rendered).toContain('Routing finished; the local operation is continuing');
  });

  it.each([
    ['contended', 'contended commit completed'],
    ['capacity-exhausted', 'repair the storage-capacity condition'],
    ['io-failed', 'repair the reported storage condition'],
    ['storage-corrupt', 'routing-status discard successor'],
  ] as const)('keeps the $0 uncertainty on a completed terminal publication incident', (cause, prerequisite) => {
    const rendered = formatHandoffPublicationIncident({
      phase: 'terminal',
      invocationId: PUBLICATION_INVOCATION_ID,
      terminalDisposition: {
        kind: 'continued-current',
        reason: { kind: 'routing', basis: { kind: 'incumbent-absent' } },
      },
      kind: 'commit-outcome-unknown',
      cause,
      errcode: 5,
    });

    expect(rendered).toContain(prerequisite);
    expect(rendered).toContain('Routing finished; the local operation is continuing');
  });

  it('reports a terminal invalid-record defect and distinguishes failed work from its failed record', () => {
    const rendered = formatHandoffPublicationIncident({
      phase: 'terminal',
      invocationId: PUBLICATION_INVOCATION_ID,
      terminalDisposition: { kind: 'execution-failed', throwPhase: 'child-spawn' },
      kind: 'not-published',
      cause: 'invalid-record',
      validation: { kind: 'schema-violation' },
    });

    expect(rendered).toContain('report the invalid routing-status record (schema-violation) as a Coral defect');
    expect(rendered).toContain(`coral-cli backend routing-status resolve --invocation ${PUBLICATION_INVOCATION_ID}`);
    expect(rendered).toContain("The operation failed; follow the original error's remediation, then retry it");
    expect(rendered).not.toContain('<id>');
    expect(rendered).not.toContain('do not rerun it');
  });

  it.each([
    [{ kind: 'delegated-success', version: '2.3.4' } as const, 'The delegated operation succeeded; do not rerun it'],
    [
      { kind: 'delegated-exit', version: '2.3.4', exitCode: 23 } as const,
      "The delegated child exited with code 23; follow the child's own diagnosis",
    ],
    [
      { kind: 'delegated-signal', version: '2.3.4', signal: 'SIGTERM' } as const,
      "The delegated child ended from signal SIGTERM; use the child's output to diagnose the operation",
    ],
  ])(
    'describes the recorded delegated outcome without generalizing it as finished',
    (terminalDisposition, expected) => {
      const rendered = formatHandoffPublicationIncident({
        phase: 'terminal',
        invocationId: PUBLICATION_INVOCATION_ID,
        terminalDisposition,
        kind: 'not-published',
        cause: 'contended',
      });

      expect(rendered).toContain(expected);
      expect(rendered).not.toContain('The operation finished');
    },
  );

  it.each<readonly [Extract<HandoffPublicationIncident, { kind: 'refused' }>, string]>([
    [
      {
        phase: 'selection',
        invocationId: PUBLICATION_INVOCATION_ID,
        kind: 'refused',
        refusal: {
          reason: 'owner-identity-unavailable',
          remediation: 'retry-when-process-identity-is-readable',
          attemptedPhase: 'selection',
        },
      },
      'wait until this process identity is readable',
    ],
    [
      {
        phase: 'selection',
        invocationId: PUBLICATION_INVOCATION_ID,
        kind: 'refused',
        refusal: {
          reason: 'invalid-target-authority',
          remediation: 'retry-with-live-target-authority',
          attemptedPhase: 'selection',
        },
      },
      'wait until live target authority is available',
    ],
    [
      {
        phase: 'terminal',
        invocationId: PUBLICATION_INVOCATION_ID,
        terminalDisposition: {
          kind: 'continued-current',
          reason: { kind: 'routing', basis: { kind: 'incumbent-absent' } },
        },
        kind: 'refused',
        refusal: {
          reason: 'selection-publication-outcome-unknown',
          remediation: 'inspect-routing-status-before-repair',
          attemptedPhase: 'terminal',
        },
      },
      'rerun coral-cli backend status',
    ],
    // The refusal with no terminal disposition: it exists because none was reached, so the successor cannot
    // describe what the delegated work did, and must still name the command that settles the invocation.
    [
      {
        phase: 'terminal',
        invocationId: PUBLICATION_INVOCATION_ID,
        kind: 'refused',
        refusal: {
          reason: 'startup-readiness-unobserved',
          remediation: 'inspect-backend-status-before-repair',
          attemptedPhase: 'terminal',
        },
      },
      'rerun coral-cli backend status to see whether the selected build is serving',
    ],
  ])('renders an actionable successor without exposing refusal tokens', (incident, expected) => {
    const rendered = formatHandoffPublicationIncident(incident);
    expect(rendered).toContain(`Next step: ${expected}`);
    expect(rendered).not.toContain(incident.refusal.reason);
    expect(rendered).not.toContain(incident.refusal.remediation);
  });

  const cases = [
    { daemonContribution: 0, liveContribution: 0, routingContribution: 0, publicationContribution: 0, expected: 0 },
    { daemonContribution: 75, liveContribution: 0, routingContribution: 0, publicationContribution: 0, expected: 75 },
    { daemonContribution: 0, liveContribution: 75, routingContribution: 0, publicationContribution: 0, expected: 75 },
    { daemonContribution: 0, liveContribution: 0, routingContribution: 75, publicationContribution: 0, expected: 75 },
    { daemonContribution: 0, liveContribution: 0, routingContribution: 0, publicationContribution: 75, expected: 75 },
    { daemonContribution: 0, liveContribution: 0, routingContribution: 0, publicationContribution: 70, expected: 70 },
    { daemonContribution: 75, liveContribution: 0, routingContribution: 0, publicationContribution: 70, expected: 70 },
  ] as const;

  it.each(cases)(
    'combines daemon=$daemonContribution live=$liveContribution routing=$routingContribution publication=$publicationContribution as $expected',
    async ({ daemonContribution, liveContribution, routingContribution, publicationContribution, expected }) => {
      const continuation: LiveHandoffContinuationResult =
        liveContribution === 75
          ? { kind: 'run-current', reason: { kind: 'handoff-abandoned', reason: 'stdout-drain-incomplete' } }
          : { kind: 'run-current', reason: { kind: 'routing', basis: { kind: 'incumbent-absent' } } };
      const live =
        liveContribution === 0 && publicationContribution === 0
          ? null
          : liveHandoffResult(
              continuation,
              publicationContribution === 70
                ? [
                    {
                      phase: 'selection',
                      invocationId: PUBLICATION_INVOCATION_ID,
                      kind: 'not-published',
                      cause: 'invalid-record',
                      validation: { kind: 'schema-violation' },
                    },
                  ]
                : publicationContribution === 75
                  ? [
                      {
                        phase: 'selection',
                        invocationId: PUBLICATION_INVOCATION_ID,
                        kind: 'not-published',
                        cause: 'contended',
                      },
                    ]
                  : [],
            );
      const status: BackendStatusCommandOperations = {
        inspectReadiness: () => ({ kind: 'no-legacy' }),
        readProviderProxySetHolderStatusDirect: noDirectProviderProxySetHolders,
        getStatus: async () =>
          daemonContribution === 75
            ? { status: 'undecodable_record', reason: 'corrupt-json', path: '/run/coordinator.json' }
            : { status: 'no_record_no_socket' },
        getLiveHandoffResult: () => live,
        getRoutingStatus: async () =>
          routingContribution === 75 ? { kind: 'unreadable', reason: 'invalid-json' } : { kind: 'absent' },
      };
      const program = new Command();
      program.exitOverride();
      registerBackendCommands(program, { storeReset, backendStatus: status });

      await program.parseAsync(['node', 'coral-cli', 'backend', 'status']);

      expect(process.exitCode).toBe(expected);
    },
  );
});

describe('backend routing status', () => {
  it('should keep every hold visible once history has reached the store ceilings', () => {
    const terminals = Array.from({ length: MAX_COMPLETED_HANDOFF_ROUTING_PAIRS }, (_, index) => ({
      kind: 'terminal' as const,
      selection: null,
      terminal: {
        generation: HANDOFF_ROUTING_STATUS_GENERATION,
        sequence: index + 1_000,
        eventId: `terminal-event-${index}`,
        invocationId: `terminal-${index}`,
        observedAt: '2026-08-02T00:00:00.000Z',
        eventKind: 'continuation-finalized' as const,
        phase: 'terminal' as const,
        selection: { kind: 'with-selection-sequence' as const, selectionSequence: index + 1 },
        disposition: { kind: 'delegated-exit' as const, version: '0.10.9', exitCode: 7 },
      },
    }));
    const compacted = Array.from({ length: MAX_RETIREMENT_TOMBSTONES }, (_, index) => ({
      kind: 'retired' as const,
      selection: null,
      tombstone: {
        generation: HANDOFF_ROUTING_STATUS_GENERATION,
        sequence: index + 10,
        invocationId: `settled-${index}`,
        retirementCause: 'completed-pair-compaction' as const,
        selectedDisposition: null,
        terminalExisted: true,
        resolutionReason: null,
        observedAt: '2026-08-01T00:00:00.000Z',
      },
    }));
    const routingStatus = {
      kind: 'current' as const,
      generation: HANDOFF_ROUTING_STATUS_GENERATION,
      statuses: [
        {
          kind: 'unresolved' as const,
          selection: {
            generation: HANDOFF_ROUTING_STATUS_GENERATION,
            sequence: 1,
            eventId: 'needs-action-event',
            invocationId: 'needs-action-invocation',
            observedAt: '2026-08-01T00:00:00.000Z',
            eventKind: 'routing-selected' as const,
            phase: 'selection' as const,
            owner: { pid: 101, incarnation: testIncarnation(101) },
            disposition: {
              kind: 'continue-current' as const,
              basis: { kind: 'same-build-set' as const, buildSetId: '123e4567-e89b-42d3-a456-426614174000' },
            },
          },
          ownerLiveness: { kind: 'absent' as const },
        },
        {
          kind: 'retired' as const,
          selection: null,
          tombstone: {
            generation: HANDOFF_ROUTING_STATUS_GENERATION,
            sequence: 9,
            invocationId: 'evicted-invocation',
            retirementCause: 'selection-evicted-at-capacity' as const,
            selectedDisposition: {
              kind: 'continue-current' as const,
              basis: { kind: 'same-build-set' as const, buildSetId: '123e4567-e89b-42d3-a456-426614174000' },
            },
            terminalExisted: false,
            resolutionReason: null,
            observedAt: '2026-08-01T00:00:00.000Z',
          },
        },
        ...compacted,
        ...terminals,
      ],
      retirementHistoryTruncated: {
        kind: 'retirement-history-truncated' as const,
        expiredIdentityCount: 0,
        causes: { 'selection-evicted-at-capacity': 0, 'completed-pair-compaction': 0, 'operator-resolved': 0 },
        minSelectionSequence: 0,
        maxSelectionSequence: 0,
        earliestSelectedAt: null,
        latestSelectedAt: null,
      },
    } as unknown as Parameters<typeof formatHandoffRoutingStatus>[0];

    const rendered = formatHandoffRoutingStatus(routingStatus) ?? '';

    expect(rendered).toContain('needs-action-invocation');
    expect(rendered, 'a hold that is not `unresolved` survives the collapse too').toContain('evicted-invocation');
    expect(rendered, 'a compaction retirement is history').not.toContain('settled-0');
    expect(rendered, 'a terminal is history, which is the case the field hit').not.toContain('terminal-0');
    expect(rendered).toContain(
      `Routing invocations already history, needing no action: ${MAX_RETIREMENT_TOMBSTONES + MAX_COMPLETED_HANDOFF_ROUTING_PAIRS}.`,
    );
  });

  it('renders invocation dispositions and aggregate retirement history in journal order', async () => {
    const routingStatus = {
      kind: 'current',
      generation: HANDOFF_ROUTING_STATUS_GENERATION,
      statuses: [
        {
          kind: 'unresolved',
          selection: {
            generation: HANDOFF_ROUTING_STATUS_GENERATION,
            sequence: 1,
            eventId: 'unresolved-event',
            invocationId: 'unresolved-invocation',
            observedAt: '2026-08-01T00:00:00.000Z',
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
        {
          kind: 'terminal',
          selection: null,
          terminal: {
            generation: HANDOFF_ROUTING_STATUS_GENERATION,
            sequence: 2,
            eventId: 'terminal-event',
            invocationId: 'terminal-invocation',
            observedAt: '2026-08-02T00:00:00.000Z',
            eventKind: 'continuation-finalized',
            phase: 'terminal',
            selection: { kind: 'with-selection-sequence', selectionSequence: 1 },
            disposition: { kind: 'delegated-exit', version: '0.10.9', exitCode: 7 },
          },
        },
        {
          kind: 'retired',
          tombstone: {
            generation: HANDOFF_ROUTING_STATUS_GENERATION,
            sequence: 3,
            eventId: 'retired-event',
            invocationId: 'retired-invocation',
            observedAt: '2026-08-03T00:00:00.000Z',
            eventKind: 'retirement-tombstone',
            phase: 'retirement',
            selectionSequence: 2,
            selectedAt: '2026-08-01T00:00:00.000Z',
            owner: { pid: 102, incarnation: testIncarnation(102) },
            selectedDisposition: {
              kind: 'continue-current',
              basis: { kind: 'same-build-set', buildSetId: '223e4567-e89b-42d3-a456-426614174000' },
            },
            retirementCause: 'completed-pair-compaction',
            terminalExisted: true,
          },
        },
        {
          kind: 'retired',
          tombstone: {
            generation: HANDOFF_ROUTING_STATUS_GENERATION,
            sequence: 4,
            eventId: 'operator-resolved-event',
            invocationId: 'operator-resolved-invocation',
            observedAt: '2026-08-04T00:00:00.000Z',
            eventKind: 'retirement-tombstone',
            phase: 'retirement',
            selectionSequence: 3,
            selectedAt: '2026-08-02T00:00:00.000Z',
            owner: { pid: 103, incarnation: testIncarnation(103) },
            selectedDisposition: {
              kind: 'continue-current',
              basis: { kind: 'same-build-set', buildSetId: '323e4567-e89b-42d3-a456-426614174000' },
            },
            retirementCause: 'operator-resolved',
            terminalExisted: false,
            resolutionReason: 'owner-absent',
          },
        },
      ],
      retirementHistoryTruncated: {
        kind: 'retirement-history-truncated',
        expiredIdentityCount: 2,
        causes: {
          'selection-evicted-at-capacity': 1,
          'completed-pair-compaction': 1,
          'operator-resolved': 0,
        },
        minSelectionSequence: 4,
        maxSelectionSequence: 8,
        earliestSelectedAt: '2026-07-01T00:00:00.000Z',
        latestSelectedAt: '2026-07-03T00:00:00.000Z',
      },
    } satisfies HandoffRoutingStatusReadResult;

    const rendered = formatHandoffRoutingStatus(routingStatus) ?? '';
    expect(rendered.split('\n')).toEqual([
      'Routing invocation unresolved-invocation: unresolved; its recorded owner is absent.',
      'Selected routing: continued current (same-build-set: 123e4567-e89b-42d3-a456-426614174000).',
      'Routing hold: run the resolution command below.',
      'command=coral-cli backend routing-status resolve --invocation unresolved-invocation',
      'Routing invocation terminal-invocation: terminal; delegated to 0.10.9, which exited 7.',
      'Routing invocation retired-invocation: retired (completed-pair-compaction). No action is needed.',
      'Routing invocation operator-resolved-invocation: retired (operator-resolved; reason: owner-absent). No action is needed.',
      'Routing retirement history: 2 exact invocation identities expired (selection-evicted-at-capacity=1, completed-pair-compaction=1, operator-resolved=0); observed selection sequence range 4-8, selected 2026-07-01T00:00:00.000Z through 2026-07-03T00:00:00.000Z.',
    ]);
    const dispatched: RecordedBackendCommand[] = [];
    await executeRenderedCommand(backendCommandProgram(dispatched), rendered, { label: 'command' });
    expect(dispatched).toEqual([
      { kind: 'routing-status-resolve', invocationId: 'unresolved-invocation', forceUnobservable: false },
    ]);
  });

  it('renders the retained routing cause on actionable unresolved entries', () => {
    const result: HandoffRoutingStatusReadResult = {
      kind: 'current',
      generation: HANDOFF_ROUTING_STATUS_GENERATION,
      statuses: (['unreadable-record', 'health-shape-rejected'] as const).map(
        (cause, index) =>
          ({
            kind: 'unresolved',
            selection: {
              generation: HANDOFF_ROUTING_STATUS_GENERATION,
              sequence: index + 1,
              eventId: `event-${index}`,
              invocationId: `invocation-${index}`,
              observedAt: '2026-08-03T00:00:00.000Z',
              eventKind: 'routing-selected',
              phase: 'selection',
              owner: { pid: 101 + index, incarnation: testIncarnation(101 + index) },
              disposition: { kind: 'continue-current', basis: { kind: 'incumbent-unresolved', cause } },
            },
            ownerLiveness: { kind: 'absent' },
          }) as const,
      ),
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

    const rendered = formatHandoffRoutingStatus(result);
    expect(rendered).toContain('Selected routing: continued current (incumbent-unresolved: unreadable-record).');
    expect(rendered).toContain('Selected routing: continued current (incumbent-unresolved: health-shape-rejected).');
  });

  it.each([
    {
      name: 'capacity eviction before a terminal',
      retirementCause: 'selection-evicted-at-capacity',
      terminalExisted: false,
      expected:
        'Routing invocation retired-invocation: retired (selection-evicted-at-capacity; terminal recorded: no).\nSelected routing: continued current (same-build-set: 123e4567-e89b-42d3-a456-426614174000).\nRouting hold: run the resolution command below to acknowledge the retained capacity eviction.\ncommand=coral-cli backend routing-status resolve --invocation retired-invocation',
    },
    {
      name: 'capacity eviction with a terminal',
      retirementCause: 'selection-evicted-at-capacity',
      terminalExisted: true,
      expected:
        'Routing invocation retired-invocation: retired (selection-evicted-at-capacity; terminal recorded: yes).\nSelected routing: continued current (same-build-set: 123e4567-e89b-42d3-a456-426614174000).\nRouting hold: run the resolution command below to acknowledge the retained capacity eviction.\ncommand=coral-cli backend routing-status resolve --invocation retired-invocation',
    },
    {
      name: 'absent-owner resolution',
      retirementCause: 'operator-resolved',
      terminalExisted: false,
      resolutionReason: 'owner-absent',
      expected:
        'Routing invocation retired-invocation: retired (operator-resolved; reason: owner-absent). No action is needed.',
    },
    {
      name: 'forced unobservable-owner resolution',
      retirementCause: 'operator-resolved',
      terminalExisted: false,
      resolutionReason: 'operator-abandoned-unobservable',
      expected:
        'Routing invocation retired-invocation: retired (operator-resolved; reason: operator-abandoned-unobservable). No action is needed.',
    },
  ] as const)('renders retained evidence for $name', async ({ retirementCause, terminalExisted, ...testCase }) => {
    const tombstone = handoffRoutingRecordSchemaRegistry.retirement.parse({
      generation: HANDOFF_ROUTING_STATUS_GENERATION,
      sequence: 1,
      eventId: 'retirement-event',
      invocationId: 'retired-invocation',
      observedAt: '2026-08-03T00:00:00.000Z',
      eventKind: 'retirement-tombstone',
      phase: 'retirement',
      selectionSequence: 1,
      selectedAt: '2026-08-02T00:00:00.000Z',
      owner: { pid: 101, incarnation: testIncarnation(101) },
      selectedDisposition: {
        kind: 'continue-current',
        basis: { kind: 'same-build-set', buildSetId: '123e4567-e89b-42d3-a456-426614174000' },
      },
      retirementCause,
      terminalExisted,
      ...('resolutionReason' in testCase ? { resolutionReason: testCase.resolutionReason } : {}),
    });
    const result: HandoffRoutingStatusReadResult = {
      kind: 'current',
      generation: HANDOFF_ROUTING_STATUS_GENERATION,
      statuses: [{ kind: 'retired', tombstone }],
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

    const rendered = formatHandoffRoutingStatus(result) ?? '';
    expect(rendered).toBe(testCase.expected);
    if (retirementCause === 'selection-evicted-at-capacity') {
      const dispatched: RecordedBackendCommand[] = [];
      await executeRenderedCommand(backendCommandProgram(dispatched), rendered, { label: 'command' });
      expect(dispatched).toEqual([
        { kind: 'routing-status-resolve', invocationId: 'retired-invocation', forceUnobservable: false },
      ]);
    }
  });

  it('renders an unresolved invocation ID and contributes exit 75 for an absent owner', async () => {
    const invocationId = '123e4567-e89b-42d3-a456-426614174000';
    const routingStatus: HandoffRoutingStatusReadResult = {
      kind: 'current',
      generation: HANDOFF_ROUTING_STATUS_GENERATION,
      statuses: [
        {
          kind: 'unresolved',
          selection: {
            generation: HANDOFF_ROUTING_STATUS_GENERATION,
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
      getStatus: async () => ({ status: 'no_record_no_socket' }),
      getLiveHandoffResult: () => null,
      readProviderProxySetHolderStatusDirect: noDirectProviderProxySetHolders,
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

  it('renders aggregate-only retirement history without keeping the expired capacity gate', async () => {
    const status: BackendStatusCommandOperations = {
      inspectReadiness: () => ({ kind: 'no-legacy' }),
      getStatus: async () => ({ status: 'no_record_no_socket' }),
      getLiveHandoffResult: () => null,
      readProviderProxySetHolderStatusDirect: noDirectProviderProxySetHolders,
      getRoutingStatus: async () => ({
        kind: 'current',
        generation: HANDOFF_ROUTING_STATUS_GENERATION,
        statuses: [],
        retirementHistoryTruncated: {
          kind: 'retirement-history-truncated',
          expiredIdentityCount: 3,
          causes: {
            'selection-evicted-at-capacity': 1,
            'completed-pair-compaction': 2,
            'operator-resolved': 0,
          },
          minSelectionSequence: 7,
          maxSelectionSequence: 11,
          earliestSelectedAt: '2026-08-01T00:00:00.000Z',
          latestSelectedAt: '2026-08-03T00:00:00.000Z',
        },
      }),
    };
    const program = new Command();
    program.exitOverride();
    registerBackendCommands(program, { storeReset, backendStatus: status });

    await program.parseAsync(['node', 'coral-cli', 'backend', 'status']);

    expect(stdout).toContain('Routing retirement history: 3 exact invocation identities expired');
    expect(stdout).toContain('selection-evicted-at-capacity=1');
    expect(process.exitCode).toBe(0);
  });

  it('renders committed selection-gap terminals as history without keeping backend status at 75', async () => {
    const failedInvocationId = '123e4567-e89b-42d3-a456-426614174010';
    const finalizedInvocationId = '123e4567-e89b-42d3-a456-426614174011';
    const status: BackendStatusCommandOperations = {
      inspectReadiness: () => ({ kind: 'no-legacy' }),
      getStatus: async () => ({ status: 'no_record_no_socket' }),
      getLiveHandoffResult: () => null,
      readProviderProxySetHolderStatusDirect: noDirectProviderProxySetHolders,
      getRoutingStatus: async () => ({
        kind: 'current',
        generation: HANDOFF_ROUTING_STATUS_GENERATION,
        statuses: [
          {
            kind: 'terminal',
            selection: null,
            terminal: {
              generation: HANDOFF_ROUTING_STATUS_GENERATION,
              sequence: 1,
              eventId: 'failed-gap-event',
              invocationId: failedInvocationId,
              observedAt: '2026-08-03T00:00:00.000Z',
              eventKind: 'execution-failed',
              phase: 'terminal',
              selection: { kind: 'without-selection' },
              disposition: { kind: 'failed-without-selection', throwPhase: 'child-spawn' },
            },
          },
          {
            kind: 'terminal',
            selection: null,
            terminal: {
              generation: HANDOFF_ROUTING_STATUS_GENERATION,
              sequence: 2,
              eventId: 'finalized-gap-event',
              invocationId: finalizedInvocationId,
              observedAt: '2026-08-03T00:00:01.000Z',
              eventKind: 'continuation-finalized',
              phase: 'terminal',
              selection: { kind: 'without-selection' },
              disposition: {
                kind: 'finalized-without-selection',
                terminal: { kind: 'delegated-success', version: '0.10.9' },
              },
            },
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
      }),
    };
    const program = new Command();
    program.exitOverride();
    registerBackendCommands(program, { storeReset, backendStatus: status });

    await program.parseAsync(['node', 'coral-cli', 'backend', 'status']);

    expect(stdout).toContain(
      `Routing invocation ${failedInvocationId}: terminal; execution failed during child-spawn without a retained selection.`,
    );
    expect(stdout).toContain(
      `Routing invocation ${finalizedInvocationId}: terminal; delegated successfully to 0.10.9 without a retained selection.`,
    );
    expect(process.exitCode).toBe(0);
  });

  it('keeps the capacity gate while the exact retirement tombstone is retained', async () => {
    const status: BackendStatusCommandOperations = {
      inspectReadiness: () => ({ kind: 'no-legacy' }),
      getStatus: async () => ({ status: 'no_record_no_socket' }),
      getLiveHandoffResult: () => null,
      readProviderProxySetHolderStatusDirect: noDirectProviderProxySetHolders,
      getRoutingStatus: async () => ({
        kind: 'current',
        generation: HANDOFF_ROUTING_STATUS_GENERATION,
        statuses: [
          {
            kind: 'retired',
            tombstone: {
              generation: HANDOFF_ROUTING_STATUS_GENERATION,
              sequence: 2,
              eventId: 'retirement-event',
              invocationId: 'routing-invocation',
              observedAt: '2026-08-03T00:00:00.000Z',
              eventKind: 'retirement-tombstone',
              phase: 'retirement',
              selectionSequence: 1,
              selectedAt: '2026-08-02T00:00:00.000Z',
              owner: { pid: 101, incarnation: testIncarnation(101) },
              selectedDisposition: {
                kind: 'continue-current',
                basis: { kind: 'same-build-set', buildSetId: '123e4567-e89b-42d3-a456-426614174000' },
              },
              retirementCause: 'selection-evicted-at-capacity',
              terminalExisted: false,
            },
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
      }),
    };
    const program = new Command();
    program.exitOverride();
    registerBackendCommands(program, { storeReset, backendStatus: status });

    await program.parseAsync(['node', 'coral-cli', 'backend', 'status']);

    expect(stdout).toContain(
      'Routing invocation routing-invocation: retired (selection-evicted-at-capacity; terminal recorded: no).',
    );
    expect(stdout).toContain(
      'Selected routing: continued current (same-build-set: 123e4567-e89b-42d3-a456-426614174000).',
    );
    const dispatched: RecordedBackendCommand[] = [];
    await executeRenderedCommand(backendCommandProgram(dispatched), stdout, { label: 'command' });
    expect(dispatched).toEqual([
      { kind: 'routing-status-resolve', invocationId: 'routing-invocation', forceUnobservable: false },
    ]);
    expect(process.exitCode).toBe(75);
  });
});

describe('handoff continuation remediation', () => {
  const cases: ReadonlyArray<{
    name: string;
    reason: HandoffContinuationReason;
    expected: string;
    expectedCommand?: RecordedBackendCommand;
  }> = [
    {
      name: 'unrecognized incumbent health',
      reason: {
        kind: 'routing',
        basis: { kind: 'incumbent-unresolved', cause: 'health-shape-rejected' },
      },
      expected: [
        'Handoff: continuing current build — the incumbent coordinator could not be resolved because its authenticated health reply was not recognized.',
        'Handoff hold: run the shutdown command below, then run any mutating Coral command (or start a Claude Code session); it attempts startup or handoff from the current installation.',
        'command=coral-cli backend shutdown',
      ].join('\n'),
      expectedCommand: { kind: 'shutdown' },
    },
    {
      name: 'unreadable incumbent record',
      reason: {
        kind: 'routing',
        basis: { kind: 'incumbent-unresolved', cause: 'unreadable-record' },
      },
      expected: [
        'Handoff: continuing current build — the incumbent coordinator could not be resolved because its coordinator record could not be read.',
        'Handoff hold: follow the daemon-status remediation above; do not proceed while the backend status command exits 75.',
      ].join('\n'),
    },
    {
      name: 'failed incumbent health request',
      reason: {
        kind: 'routing',
        basis: { kind: 'incumbent-unresolved', cause: 'health-request-failed' },
      },
      expected: [
        'Handoff: continuing current build — the incumbent coordinator could not be resolved because its authenticated health request did not complete.',
        'Handoff hold: follow the daemon-status remediation above; do not proceed while the backend status command exits 75.',
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
        'Handoff hold: wait for backend shutdown to finish, then retry.',
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
        'Handoff hold: repair or reinstall this Coral bundle, then retry.',
      ].join('\n'),
    },
    {
      name: 'incumbent identity unavailable',
      reason: {
        kind: 'routing',
        basis: {
          kind: 'incumbent-identity-unavailable',
          incumbent: incumbentIdentitySummarySchema.parse({
            version: '2.1.0',
            bundleHash: 'f'.repeat(16),
            flavor: 'prod',
            instanceId: 'incumbent-1',
          }),
        },
      },
      expected: [
        'Handoff: continuing current build — incumbent 2.1.0 did not report a complete bundle identity.',
        'Handoff hold: run the shutdown command below, then rerun a mutating command; it attempts startup or handoff from this installation.',
        'command=coral-cli backend shutdown',
      ].join('\n'),
      expectedCommand: { kind: 'shutdown' },
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
        'Handoff hold: run the shutdown command below, then rerun a mutating command; it attempts startup or handoff from this installation.',
        'command=coral-cli backend shutdown',
      ].join('\n'),
      expectedCommand: { kind: 'shutdown' },
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
        'Handoff hold: repair or reinstall the Coral installation at /opt/coral-old, then retry.',
      ].join('\n'),
    },
    {
      name: 'abandoned delegation',
      reason: { kind: 'handoff-abandoned', reason: 'stdout-drain-incomplete' },
      expected: [
        'Handoff: continuing current build — delegation was abandoned because stdout did not finish draining.',
        "Handoff hold: retry; if stdout still does not drain, preserve the output and inspect the invoking process's stdout consumer.",
      ].join('\n'),
    },
  ];

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

  it.each(cases)('authors a next step for $name', async ({ reason, expected, expectedCommand }) => {
    const rendered = formatHandoffContinuationReason(reason);

    expect(rendered).toBe(expected);
    if (expectedCommand === undefined) {
      expect(rendered).not.toContain('command=');
    } else {
      const dispatched: RecordedBackendCommand[] = [];
      await executeRenderedCommand(backendCommandProgram(dispatched), rendered, { label: 'command' });
      expect(dispatched).toEqual([expectedCommand]);
    }
    expect(RAW_ENUM_TOKENS.filter((token) => rendered.includes(token))).toEqual([]);
    expect(rendered).not.toMatch(/\brelaunch(?:es|ing)?\b/iu);
    expect(rendered).not.toContain('Backend not running');
  });
});

describe('backend status subordinate guidance', () => {
  type CurrentRoutingStatus = Extract<HandoffRoutingStatusReadResult, { kind: 'current' }>;
  type UnresolvedInvocation = Extract<HandoffRoutingInvocationStatus, { kind: 'unresolved' }>;
  type TerminalInvocation = Extract<HandoffRoutingInvocationStatus, { kind: 'terminal' }>;

  const noGuidanceDaemonStatus = { status: 'no_record_no_socket' } satisfies BackendStatusFull;
  const emptyRetirementHistory = {
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
  } satisfies RetirementHistoryTruncated;

  const routingSelection = (invocationId: string): UnresolvedInvocation['selection'] => ({
    generation: HANDOFF_ROUTING_STATUS_GENERATION,
    sequence: 1,
    eventId: 'selection-event',
    invocationId,
    observedAt: '2026-08-03T00:00:00.000Z',
    eventKind: 'routing-selected',
    phase: 'selection',
    owner: { pid: 101, incarnation: testIncarnation(101) },
    disposition: {
      kind: 'continue-current',
      basis: { kind: 'same-build-set', buildSetId: '123e4567-e89b-42d3-a456-426614174000' },
    },
  });

  const routingTerminal = (invocationId: string): TerminalInvocation['terminal'] =>
    handoffRoutingRecordSchemaRegistry.terminal.parse({
      generation: HANDOFF_ROUTING_STATUS_GENERATION,
      sequence: 2,
      eventId: 'terminal-event',
      invocationId,
      observedAt: '2026-08-03T00:00:01.000Z',
      eventKind: 'continuation-finalized',
      phase: 'terminal',
      selection: { kind: 'with-selection-sequence', selectionSequence: 1 },
      disposition: { kind: 'delegated-success', version: '0.10.9' },
    });

  const retirementInvocation = (
    retirementCause: RetirementTombstone['retirementCause'],
    terminalExisted: boolean,
    resolutionReason?: NonNullable<RetirementTombstone['resolutionReason']>,
  ): Extract<HandoffRoutingInvocationStatus, { kind: 'retired' }> => ({
    kind: 'retired',
    tombstone: handoffRoutingRecordSchemaRegistry.retirement.parse({
      generation: HANDOFF_ROUTING_STATUS_GENERATION,
      sequence: 3,
      eventId: 'retirement-event',
      invocationId: 'retired-invocation',
      observedAt: '2026-08-03T00:00:02.000Z',
      eventKind: 'retirement-tombstone',
      phase: 'retirement',
      selectionSequence: 1,
      selectedAt: '2026-08-03T00:00:00.000Z',
      owner: { pid: 101, incarnation: testIncarnation(101) },
      selectedDisposition: {
        kind: 'continue-current',
        basis: { kind: 'same-build-set', buildSetId: '123e4567-e89b-42d3-a456-426614174000' },
      },
      retirementCause,
      terminalExisted,
      ...(resolutionReason === undefined ? {} : { resolutionReason }),
    }),
  });

  const currentRoutingStatus = (
    statuses: readonly HandoffRoutingInvocationStatus[],
    retirementHistoryTruncated: RetirementHistoryTruncated = emptyRetirementHistory,
  ): CurrentRoutingStatus => ({
    kind: 'current',
    generation: HANDOFF_ROUTING_STATUS_GENERATION,
    statuses,
    retirementHistoryTruncated,
  });

  it('keeps the routing-status classification matrix below the daemon guidance namespace', () => {
    const cases = {
      absent: { kind: 'absent' },
      vacant: { kind: 'vacant' },
      uninitialized: { kind: 'uninitialized' },
      'detached-wal': { kind: 'detached-wal' },
      'generation-missing': { kind: 'generation-missing' },
      'foreign-generation': { kind: 'foreign-generation', generation: 2 },
      'format-mismatch': { kind: 'format-mismatch' },
      'schema-divergent': { kind: 'schema-divergent' },
      unreadable: { kind: 'unreadable', reason: 'invalid-json' },
      undeterminable: { kind: 'undeterminable', cause: 'io-failed', errcode: 5 },
      current: currentRoutingStatus([]),
    } satisfies Record<HandoffRoutingStatusReadResult['kind'], HandoffRoutingStatusReadResult>;
    const expectedCommands = {
      absent: [],
      vacant: [],
      uninitialized: [],
      'detached-wal': ['command=coral-cli backend routing-status discard'],
      'generation-missing': ['command=coral-cli backend routing-status discard'],
      'foreign-generation': ['command=coral-cli backend routing-status discard'],
      'format-mismatch': ['command=coral-cli backend routing-status discard'],
      'schema-divergent': ['command=coral-cli backend routing-status discard'],
      unreadable: ['command=coral-cli backend routing-status discard'],
      undeterminable: ['command=coral-cli backend status'],
      current: [],
    } satisfies Record<HandoffRoutingStatusReadResult['kind'], readonly string[]>;

    for (const [name, routingStatus] of Object.entries(cases)) {
      const output = formatBackendStatus(noGuidanceDaemonStatus, routingStatus, null);
      expect(nextStepLines(output), name).toEqual([]);
      expect(operatorArtifactLines(output), name).toEqual(expectedCommands[name as keyof typeof expectedCommands]);
      if (expectedCommands[name as keyof typeof expectedCommands].length > 0) {
        expect(output, name).toContain('Routing hold:');
      }
    }
  });

  it('covers every routing invocation kind through the composed formatter', () => {
    const cases = {
      unresolved: {
        kind: 'unresolved',
        selection: routingSelection('unresolved-invocation'),
        ownerLiveness: { kind: 'alive' },
      },
      terminal: {
        kind: 'terminal',
        selection: null,
        terminal: routingTerminal('terminal-invocation'),
      },
      retired: retirementInvocation('completed-pair-compaction', true),
    } satisfies Record<HandoffRoutingInvocationStatus['kind'], HandoffRoutingInvocationStatus>;

    for (const [name, status] of Object.entries(cases)) {
      const output = formatBackendStatus(noGuidanceDaemonStatus, currentRoutingStatus([status]), null);
      expect(nextStepLines(output), name).toEqual([]);
    }
  });

  it('covers every owner-liveness branch, including every unobservable cause', () => {
    type UnobservableCause = Extract<OwnerLiveness, { kind: 'unobservable' }>['cause'];
    type OwnerLivenessCase = Exclude<OwnerLiveness['kind'], 'unobservable'> | UnobservableCause;
    const cases = {
      alive: { kind: 'alive' },
      absent: { kind: 'absent' },
      'incarnation-unavailable': { kind: 'unobservable', cause: 'incarnation-unavailable' },
      'probe-not-available': { kind: 'unobservable', cause: 'probe-not-available' },
      'probe-failed': { kind: 'unobservable', cause: 'probe-failed' },
      'deadline-expired': { kind: 'unobservable', cause: 'deadline-expired' },
    } satisfies Record<OwnerLivenessCase, OwnerLiveness>;
    const expectedCommands = {
      alive: [],
      absent: ['command=coral-cli backend routing-status resolve --invocation owner-liveness-invocation'],
      'incarnation-unavailable': [
        'command=coral-cli backend routing-status resolve --invocation owner-liveness-invocation --force-unobservable',
      ],
      'probe-not-available': [
        'command=coral-cli backend routing-status resolve --invocation owner-liveness-invocation --force-unobservable',
      ],
      'probe-failed': [
        'command=coral-cli backend routing-status resolve --invocation owner-liveness-invocation --force-unobservable',
      ],
      'deadline-expired': ['command=coral-cli backend status'],
    } satisfies Record<OwnerLivenessCase, readonly string[]>;

    for (const [name, ownerLiveness] of Object.entries(cases)) {
      const status = {
        kind: 'unresolved',
        selection: routingSelection('owner-liveness-invocation'),
        ownerLiveness,
      } satisfies HandoffRoutingInvocationStatus;
      const output = formatBackendStatus(noGuidanceDaemonStatus, currentRoutingStatus([status]), null);
      expect(nextStepLines(output), name).toEqual([]);
      expect(operatorArtifactLines(output), name).toEqual(expectedCommands[name as OwnerLivenessCase]);
      if (ownerLiveness.kind !== 'alive') expect(output, name).toContain('Routing hold:');
    }
  });

  it('covers every retirement branch and both capacity-eviction histories', () => {
    type RetirementCause = RetirementTombstone['retirementCause'];
    type ResolutionReason = NonNullable<RetirementTombstone['resolutionReason']>;
    const capacityEvictions = {
      'without-terminal': retirementInvocation('selection-evicted-at-capacity', false),
      'with-terminal': retirementInvocation('selection-evicted-at-capacity', true),
    } as const;
    const operatorResolutions = {
      'owner-absent': retirementInvocation('operator-resolved', false, 'owner-absent'),
      'operator-abandoned-unobservable': retirementInvocation(
        'operator-resolved',
        false,
        'operator-abandoned-unobservable',
      ),
    } satisfies Record<ResolutionReason, Extract<HandoffRoutingInvocationStatus, { kind: 'retired' }>>;
    const cases = {
      'selection-evicted-at-capacity': Object.values(capacityEvictions),
      'completed-pair-compaction': [retirementInvocation('completed-pair-compaction', true)],
      'operator-resolved': Object.values(operatorResolutions),
    } satisfies Record<RetirementCause, readonly Extract<HandoffRoutingInvocationStatus, { kind: 'retired' }>[]>;

    for (const [cause, statuses] of Object.entries(cases)) {
      for (const status of statuses) {
        const output = formatBackendStatus(noGuidanceDaemonStatus, currentRoutingStatus([status]), null);
        expect(nextStepLines(output), cause).toEqual([]);
        if (cause === 'selection-evicted-at-capacity') {
          expect(output).toContain('Routing hold: run the resolution command below');
          expect(operatorArtifactLines(output)).toEqual([
            'command=coral-cli backend routing-status resolve --invocation retired-invocation',
          ]);
        }
      }
    }

    const historyCases = {
      empty: emptyRetirementHistory,
      'capacity-eviction': {
        kind: 'retirement-history-truncated',
        expiredIdentityCount: 1,
        causes: {
          'selection-evicted-at-capacity': 1,
          'completed-pair-compaction': 0,
          'operator-resolved': 0,
        },
        minSelectionSequence: 1,
        maxSelectionSequence: 1,
        earliestSelectedAt: '2026-08-03T00:00:00.000Z',
        latestSelectedAt: '2026-08-03T00:00:00.000Z',
      },
    } satisfies Record<'empty' | 'capacity-eviction', RetirementHistoryTruncated>;
    for (const [name, history] of Object.entries(historyCases)) {
      const output = formatBackendStatus(noGuidanceDaemonStatus, currentRoutingStatus([], history), null);
      expect(nextStepLines(output), name).toEqual([]);
    }
  });

  it('covers every live handoff basis and each nested cause, comparison, and failure', () => {
    type UnresolvedCause = Extract<HandoffRoutingBasis, { kind: 'incumbent-unresolved' }>['cause'];
    type UnusableCause = Extract<HandoffRoutingBasis, { kind: 'incumbent-unusable' }>['cause'];
    type IdentityFailure = Extract<HandoffRoutingBasis, { kind: 'invoking-identity-unavailable' }>['failure'];
    type BuildComparison = Extract<HandoffRoutingBasis, { kind: 'invoking-build-not-older' }>['comparison'];
    type InvalidTargetFailure = Extract<
      HandoffRoutingBasis,
      { kind: 'invalid-incumbent-target' }
    >['evidence']['failure'];
    const invoking = {
      version: '2.1.0',
      buildSetId: '123e4567-e89b-42d3-a456-426614174000',
      bundleHash: 'invoking-bundle',
      flavor: 'prod',
    } as const;
    const incumbent = {
      version: '2.0.0',
      buildSetId: '223e4567-e89b-42d3-a456-426614174000',
      bundleHash: 'incumbent-bundle',
      flavor: 'prod',
    } as const;
    const unresolved = {
      'unreadable-record': { kind: 'incumbent-unresolved', cause: 'unreadable-record' },
      'health-request-failed': { kind: 'incumbent-unresolved', cause: 'health-request-failed' },
      'health-shape-rejected': { kind: 'incumbent-unresolved', cause: 'health-shape-rejected' },
    } satisfies Record<UnresolvedCause, HandoffRoutingBasis>;
    const unusable = {
      draining: { kind: 'incumbent-unusable', cause: 'draining' },
      'identity-mismatch': { kind: 'incumbent-unusable', cause: 'identity-mismatch' },
    } satisfies Record<UnusableCause, HandoffRoutingBasis>;
    const identityFailures = {
      embedded_identity_unavailable: {
        kind: 'invoking-identity-unavailable',
        failure: 'embedded_identity_unavailable',
      },
      adjacent_manifest_unavailable: {
        kind: 'invoking-identity-unavailable',
        failure: 'adjacent_manifest_unavailable',
      },
      adjacent_manifest_invalid: {
        kind: 'invoking-identity-unavailable',
        failure: 'adjacent_manifest_invalid',
      },
      adjacent_manifest_mismatch: {
        kind: 'invoking-identity-unavailable',
        failure: 'adjacent_manifest_mismatch',
      },
    } satisfies Record<IdentityFailure, HandoffRoutingBasis>;
    const comparisons = {
      'same-version': {
        kind: 'invoking-build-not-older',
        comparison: 'same-version',
        invoking,
        incumbent: { ...incumbent, version: invoking.version },
      },
      'newer-version': {
        kind: 'invoking-build-not-older',
        comparison: 'newer-version',
        invoking,
        incumbent,
      },
    } satisfies Record<BuildComparison, HandoffRoutingBasis>;
    const invalidTargets = {
      'bundle-dir-not-canonical': 'bundle-dir-not-canonical',
      'bundle-dir-unavailable': 'bundle-dir-unavailable',
      'expected-manifest-invalid': 'expected-manifest-invalid',
      'adjacent-manifest-unavailable': 'adjacent-manifest-unavailable',
      'adjacent-manifest-invalid': 'adjacent-manifest-invalid',
      'adjacent-manifest-mismatch': 'adjacent-manifest-mismatch',
      'adjacent-bundle-mismatch': 'adjacent-bundle-mismatch',
    } satisfies Record<InvalidTargetFailure, InvalidTargetFailure>;
    const invalidTargetBases = Object.fromEntries(
      Object.values(invalidTargets).map((failure) => [
        failure,
        {
          kind: 'invalid-incumbent-target',
          evidence: { bundleDir: '/opt/coral-old', expectedManifest: null, failure },
        } satisfies HandoffRoutingBasis,
      ]),
    ) as Record<InvalidTargetFailure, HandoffRoutingBasis>;
    const cases = {
      'incumbent-absent': [{ kind: 'incumbent-absent' }],
      'incumbent-unresolved': Object.values(unresolved),
      'incumbent-unusable': Object.values(unusable),
      'invoking-identity-unavailable': Object.values(identityFailures),
      'incumbent-identity-unavailable': [
        {
          kind: 'incumbent-identity-unavailable',
          incumbent: incumbentIdentitySummarySchema.parse({
            version: '2.0.0',
            bundleHash: 'f'.repeat(16),
            flavor: 'prod',
            instanceId: 'incumbent-1',
          }),
        },
      ],
      'same-build-set': [{ kind: 'same-build-set', buildSetId: '123e4567-e89b-42d3-a456-426614174000' }],
      'invoking-build-not-older': Object.values(comparisons),
      'invalid-incumbent-target': Object.values(invalidTargetBases),
    } satisfies Record<HandoffRoutingBasis['kind'], readonly HandoffRoutingBasis[]>;
    const informationalKinds = new Set<HandoffRoutingBasis['kind']>(['incumbent-absent', 'same-build-set']);

    for (const [kind, bases] of Object.entries(cases)) {
      for (const basis of bases) {
        const output = formatBackendStatus(
          noGuidanceDaemonStatus,
          { kind: 'absent' },
          liveHandoffResult({ kind: 'run-current', reason: { kind: 'routing', basis } }),
        );
        expect(nextStepLines(output), kind).toEqual([]);
        if (!informationalKinds.has(basis.kind)) expect(output, kind).toContain('Handoff hold:');
      }
    }
  });

  it('covers every live handoff continuation kind through the composed formatter', () => {
    const cases = {
      routing: {
        kind: 'routing',
        basis: { kind: 'incumbent-unresolved', cause: 'health-shape-rejected' },
      },
      'handoff-not-applicable': { kind: 'handoff-not-applicable', reason: 'display-only' },
      'handoff-abandoned': { kind: 'handoff-abandoned', reason: 'stdout-drain-incomplete' },
    } satisfies Record<HandoffContinuationReason['kind'], HandoffContinuationReason>;

    for (const [name, reason] of Object.entries(cases)) {
      const output = formatBackendStatus(
        noGuidanceDaemonStatus,
        { kind: 'absent' },
        liveHandoffResult({ kind: 'run-current', reason }),
      );
      expect(nextStepLines(output), name).toEqual([]);
    }
  });

  type AdoptionRefusal = NonNullable<RunningDiagnostics['providerOperationAdoptionRefusals']>[number];
  type AdoptionRemedy = AdoptionRefusal['remedy'];

  const adoptionRemedies = {
    'restart-coordinator': [{ kind: 'restart-coordinator' }],
    'remote-settlement': [{ kind: 'remote-settlement' }],
    'recovery-quarantine-discard': [
      { kind: 'recovery-quarantine-discard', command: { kind: 'list' } },
      {
        kind: 'recovery-quarantine-discard',
        command: {
          kind: 'discard-provider-operation',
          key: 'surviving-record',
          revision: 'fingerprint:sha256:' + 'a'.repeat(64),
          allowReadable: true,
        },
      },
    ],
    'recovery-quarantine-clear': [
      { kind: 'recovery-quarantine-clear', command: { kind: 'list' } },
      {
        kind: 'recovery-quarantine-clear',
        command: {
          kind: 'clear',
          boundary: 'provider-operation-unreadable',
          key: 'surviving-record',
          revision: 'fingerprint:sha256:' + 'b'.repeat(64),
        },
      },
    ],
    'external-repair': [{ kind: 'external-repair' }],
  } satisfies Record<AdoptionRemedy['kind'], readonly AdoptionRemedy[]>;

  const adoptionRefusal = (remedy: AdoptionRemedy): AdoptionRefusal => ({
    triggerRecordKey: 'trigger-record',
    rowDisposition: 'discarded',
    releasedLaunchPermits: 0,
    recordKey: 'surviving-record',
    jobId: 'job-1',
    operationId: 'operation-1',
    proxyInstanceId: 'proxy-1',
    buildSetId: 'build-set-1',
    reason: 'adoption refused',
    remedy,
    observedAtMs: 123,
  });

  it('uses the diagnostic lead label for every provider-operation adoption remedy', () => {
    for (const [kind, remedies] of Object.entries(adoptionRemedies)) {
      for (const remedy of remedies) {
        const output = formatBackendStatus(
          runningBackendStatus({ providerOperationAdoptionRefusals: [adoptionRefusal(remedy)] }),
          { kind: 'absent' },
          null,
        );
        expect(nextStepLines(output), kind).toEqual([]);
        expect(output, kind).toContain('Diagnostic hold');
      }
    }
  });

  it('keeps Next step at the recovery-quarantine discard call site', () => {
    const output = formatUnreadableProviderOperationDiscard({
      kind: 'adoption-refused',
      key: 'trigger-record',
      revision: 'a'.repeat(64),
      rowDisposition: 'discarded',
      releasedLaunchPermits: 0,
      refusals: [adoptionRefusal({ kind: 'restart-coordinator' })],
    });

    expect(nextStepLines(output)).toEqual([
      'Next step: for record=surviving-record, restart or repair the canonical coordinator externally; Coral retries adoption during startup. Then inspect the job and backend status.',
    ]);
  });

  it('uses hold= for every settlement-refusal recording cause', () => {
    type SettlementFailure = NonNullable<RunningDiagnostics['settlementRefusalRecordingFailures']>[number];
    const cases = {
      'terminal-persist-failed': {
        jobId: 'job-1',
        cause: 'terminal-persist-failed',
        error: 'persist failed',
        observedAtMs: 123,
      },
      'claim-release-failed': {
        jobId: 'job-1',
        cause: 'claim-release-failed',
        error: 'release failed',
        observedAtMs: 123,
      },
      'claim-already-reassigned': {
        jobId: 'job-1',
        cause: 'claim-already-reassigned',
        error: 'claim reassigned',
        observedAtMs: 123,
      },
      'settled-unbound-status-persist-failed': {
        jobId: 'job-1',
        operationId: 'operation-1',
        cause: 'settled-unbound-status-persist-failed',
        error: 'status persist failed',
        observedAtMs: 123,
      },
    } satisfies Record<SettlementFailure['cause'], SettlementFailure>;

    for (const [cause, failure] of Object.entries(cases)) {
      const output = formatBackendStatus(
        runningBackendStatus({ settlementRefusalRecordingFailures: [failure] }),
        { kind: 'absent' },
        null,
      );
      expect(nextStepLines(output), cause).toEqual([]);
      expect(output, cause).toMatch(/^\s*hold=/mu);
      expect(output, cause).not.toContain('nextStep=');
    }
  });

  it('covers every running-health diagnostics family through the composed formatter', () => {
    const setIdentity = {
      buildSetId: '11111111-1111-4111-8111-111111111111',
      hostFingerprint: 'a'.repeat(64),
      proxyInstanceId: '22222222-2222-4222-8222-222222222222',
    };
    const setToken = encodeProviderProxySetAddress(setIdentity);
    const cases = {
      launchPermits: runningBackendStatus({
        launchPermits: [
          {
            reservationId: 'reservation-1',
            jobId: 'job-1',
            pool: 'default',
            provider: 'codex',
            holder: { kind: 'local-execution' },
            executionOwner: { kind: 'provider-session', id: 'session-1' },
            heldForMs: 100,
          },
        ],
      }),
      settlementRefusalRecordingFailures: runningBackendStatus({
        settlementRefusalRecordingFailures: [
          {
            jobId: 'job-1',
            cause: 'terminal-persist-failed',
            error: 'persist failed',
            observedAtMs: 123,
          },
        ],
      }),
      launchReleaseDispositions: runningBackendStatus({
        launchReleaseDispositions: [
          {
            reservationId: 'reservation-1',
            jobId: 'job-1',
            pool: 'default',
            provider: 'codex',
            attemptedHolder: { kind: 'local-execution' },
            disposition: { kind: 'already-released', pool: 'default' },
            observedAtMs: 123,
          },
        ],
      }),
      providerOperationAdoptionRefusals: runningBackendStatus({
        providerOperationAdoptionRefusals: [adoptionRefusal({ kind: 'restart-coordinator' })],
      }),
      launchReclamations: runningBackendStatus({
        launchReclamations: [
          {
            reservationId: 'reservation-1',
            jobId: 'job-1',
            pool: 'default',
            provider: 'codex',
            holder: { kind: 'local-execution' },
            heldForMs: 100,
            evidence: { kind: 'job-absent' },
            reclaimedAtMs: 123,
          },
        ],
      }),
      carriers: runningBackendStatus({
        carriers: { coverage: 'complete', liveJobs: 0, unknownJobs: 0, recoveryDefectJobs: 0 },
      }),
      mutationBlocked: runningBackendStatus({
        mutationBlocked: { owner: 'job-1', ageMs: 100, signaledAtMs: 123 },
      }),
      consumerStuck: runningBackendStatus({
        consumerStuck: [{ id: 'consumer-1', elapsedSinceStopMs: 100 }],
      }),
      providerProxySets: runningBackendStatus({
        providerProxySets: [
          {
            setIdentity,
            setToken,
            liveClaims: 0,
            operatorExit: { kind: 'none' },
            autonomousDisposition: { kind: 'unavailable' },
            holds: [],
          },
        ],
      }),
      providerProxySetRowSkips: runningBackendStatus(
        {
          providerProxySetRowSkips: [{ reason: 'invalid-token', setToken: 'invalid-token', setIdentity: null }],
        },
        { skippedProviderProxySetRows: 1, skippedProviderProxySetTokens: ['invalid-token'] },
      ),
      providerProxyDispositionSkips: runningBackendStatus({
        providerProxyDispositionSkips: [
          { key: 'durable-key', setToken: null, unavailableAction: 'reconciliation-and-retirement' },
        ],
      }),
    } satisfies Record<keyof RunningDiagnostics, RunningBackendStatus>;

    for (const [name, status] of Object.entries(cases)) {
      const output = formatBackendStatus(status, { kind: 'absent' }, null);
      expect(nextStepLines(output), name).toEqual([]);
    }
  });

  it('covers every running component diagnostic branch through the composed formatter', () => {
    type RuntimeComponent = RunningBackendHealth['components'][number];
    type DegradedReason = Extract<RuntimeComponent, { phase: 'degraded' }>['reason'];
    type OfflineRetry = NonNullable<Extract<RuntimeComponent, { phase: 'offline' }>['diagnostic']>['retry'];
    const degraded = {
      'curate-publish': {
        id: 'curate',
        phase: 'degraded',
        reason: { kind: 'curate-publish', consecutiveFailures: 2, lastError: 'publish failed' },
      },
      'recovery-quarantine': {
        id: 'recovery',
        phase: 'degraded',
        reason: { kind: 'recovery-quarantine', count: 1, lastError: 'quarantined' },
      },
    } satisfies Record<DegradedReason['kind'], RuntimeComponent>;
    const offline = {
      unspecified: { id: 'kb', phase: 'offline', reason: 'stopped' },
      'restart-daemon': {
        id: 'kb',
        phase: 'offline',
        reason: 'stopped',
        diagnostic: { retry: 'restart-daemon' },
      },
      none: { id: 'kb', phase: 'offline', reason: 'failed', diagnostic: { retry: 'none' } },
    } satisfies Record<'unspecified' | NonNullable<OfflineRetry>, RuntimeComponent>;
    const cases = {
      initializing: [{ id: 'kb', phase: 'initializing', attempt: 1 }],
      online: [{ id: 'kb', phase: 'online' }],
      degraded: Object.values(degraded),
      offline: Object.values(offline),
    } satisfies Record<RuntimeComponent['phase'], readonly RuntimeComponent[]>;

    for (const [phase, components] of Object.entries(cases)) {
      for (const component of components) {
        const output = formatBackendStatus(
          runningBackendStatus({}, { components: [component] }),
          { kind: 'absent' },
          null,
        );
        expect(nextStepLines(output), phase).toEqual([]);
      }
    }
  });
});

describe('backend status recovery quarantine propagation', () => {
  it('carries the canonical producer reason through HTTP validation into CLI output', async () => {
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

      const status = runningStatusFromHealthPayload(produced);

      const rendered = formatBackendStatus(status, { kind: 'absent' }, null);
      expect(rendered).toContain(
        [
          '  recovery: degraded',
          '    reason: recovery-quarantine (1 unresolved row)',
          '    last error: failed to hydrate persisted workflow',
          '    hint: inspect quarantined recovery work with the command below',
          'command=coral-cli backend recovery-quarantine list',
        ].join('\n'),
      );
      const dispatched: RecordedBackendCommand[] = [];
      await executeRenderedCommand(backendCommandProgram(dispatched), rendered, { label: 'command' });
      expect(dispatched).toEqual([{ kind: 'recovery-quarantine-list' }]);
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

    const status = runningStatusFromHealthPayload(produced);

    expect(formatBackendStatus(status, { kind: 'absent' }, null)).toContain(
      '  recovery: offline\n    reason: Status unavailable:',
    );
  });
});

describe('backend status daemon guidance', () => {
  type DrainState = 'projection-zero-bound' | 'projection-positive-bound' | 'unreadable' | 'absent';

  const readableShutdown = {
    reason: 'sigterm',
    mode: 'handoff',
    elapsedMs: 100,
    boundMs: 0,
    attempt: { started: 0, limit: 3 },
  } as const satisfies NonNullable<RunningBackendHealth['shutdown']>;
  const drainingHealth = {
    status: 'draining',
    kernel: { phase: 'draining', readyAt: null },
  } as const satisfies Partial<RunningBackendHealth>;
  const drainCases = {
    'projection-zero-bound': runningBackendStatus({}, { ...drainingHealth, shutdown: readableShutdown }),
    'projection-positive-bound': runningBackendStatus(
      {},
      { ...drainingHealth, shutdown: { ...readableShutdown, boundMs: 5_000 } },
    ),
    unreadable: runningBackendStatus({}, { ...drainingHealth, shutdown: { kind: 'unreadable' } }),
    absent: runningBackendStatus({}, drainingHealth),
  } satisfies Record<DrainState, RunningBackendStatus>;
  const expectedDrainGuidance = {
    'projection-zero-bound':
      'Next step: inspect backend status again now; the current drain-work schedule has elapsed, but that does not guarantee the drain has finished',
    'projection-positive-bound':
      'Next step: inspect backend status again after the current drain-work checkpoint; this moving schedule does not guarantee the drain has finished',
    unreadable: "Next step: inspect backend status again; this build could not read the coordinator's bound",
    absent: 'Next step: inspect backend status again; the coordinator reports no bound for this drain',
  } satisfies Record<DrainState, string>;

  it('narrows selected running health to statuses the selector can return', () => {
    expectTypeOf<RunningBackendHealth['status']>().toEqualTypeOf<'ok' | 'draining'>();
  });

  it('keeps daemon guidance singular across every daemon status and running-health state', () => {
    const runningHealthCases = {
      ok: [runningBackendStatus({})],
      draining: Object.values(drainCases),
    } satisfies Record<RunningBackendHealth['status'], readonly RunningBackendStatus[]>;
    const daemonStatusCases = {
      ok: Object.values(runningHealthCases).flat(),
      unauthorized: [{ status: 'unauthorized' }],
      no_record_no_socket: [{ status: 'no_record_no_socket' }],
      recorded_process_absent: [{ status: 'recorded_process_absent', pid: 4242 }],
      undecodable_record: [{ status: 'undecodable_record', reason: 'corrupt-json', path: '/record.json' }],
      unreachable: [
        {
          status: 'unreachable',
          detail: 'connection refused',
          cause: 'refused',
          pidLiveness: 'alive',
          pid: 4242,
          recordPath: '/record.json',
        },
      ],
      no_record_socket_present: [{ status: 'no_record_socket_present', socketPath: '/coordinator.sock' }],
      recent_failure: [{ status: 'recent_failure', phase: 'startup_failed', retryable: false }],
    } satisfies Record<BackendStatusFull['status'], readonly BackendStatusFull[]>;

    for (const [statusKind, statuses] of Object.entries(daemonStatusCases)) {
      for (const status of statuses) {
        const output = formatBackendStatus(status, { kind: 'absent' }, null);
        expect(nextStepLines(output).length, statusKind).toBeLessThanOrEqual(1);
      }
    }
  });

  it.each(Object.entries(drainCases) as [DrainState, RunningBackendStatus][])(
    'renders the daemon guidance and backend-status command for %s',
    (state, status) => {
      const output = formatBackendStatus(status, { kind: 'absent' }, null);

      expect(nextStepLines(output)).toEqual([expectedDrainGuidance[state]]);
      expect(operatorArtifactLines(output)).toEqual(['command=coral-cli backend status']);
    },
  );

  it('suppresses a draining component hint without suppressing its phase or reason', () => {
    const status = runningBackendStatus(
      {},
      {
        ...drainingHealth,
        components: [
          {
            id: 'kb',
            phase: 'offline',
            reason: 'stopped',
            diagnostic: { retry: 'restart-daemon' },
          },
        ],
      },
    );

    const output = formatBackendStatus(status, { kind: 'absent' }, null);

    expect(output).toContain('  kb: offline');
    expect(output).toContain('    reason: stopped');
    expect(output).not.toMatch(/^\s*hint:/mu);
    expect(output).not.toContain('command=coral-cli backend shutdown');
  });

  it('keeps refused live-process guidance singular when routing status is absent', () => {
    const status = {
      status: 'unreachable',
      detail: 'connection refused',
      cause: 'refused',
      pidLiveness: 'alive',
      pid: 4242,
      recordPath: '/record.json',
    } as const satisfies BackendStatusFull;

    const output = formatBackendStatus(status, { kind: 'absent' }, null);

    expect(nextStepLines(output)).toHaveLength(1);
    expect(nextStepLines(output)[0]).toMatch(/^Next step: retry shortly/u);
  });
});

describe('backend status live drain section', () => {
  const readableShutdown = {
    reason: 'sigterm',
    mode: 'handoff',
    elapsedMs: 100,
    boundMs: 0,
    attempt: { started: 0, limit: 3 },
  } as const satisfies NonNullable<RunningBackendHealth['shutdown']>;

  it.each([
    ['projection', readableShutdown],
    ['unreadable', { kind: 'unreadable' } as const],
    ['absent', undefined],
  ] as const)('keeps diagnostic commands outside the %s drain region', (_state, shutdown) => {
    const status = runningBackendStatus(
      {
        providerProxySetRowSkips: [{ reason: 'invalid-token', setToken: 'invalid-token', setIdentity: null }],
      },
      {
        status: 'draining',
        kernel: { phase: 'draining', readyAt: null },
        skippedProviderProxySetRows: 1,
        skippedProviderProxySetTokens: ['invalid-token'],
        ...(shutdown === undefined ? {} : { shutdown }),
      },
    );
    const output = formatBackendStatus(status, { kind: 'absent' }, null);
    const drainStart = output.indexOf('Shutdown drain:');
    const guidanceStart = output.indexOf('\nNext step:', drainStart);

    expect(drainStart).toBeGreaterThanOrEqual(0);
    expect(guidanceStart).toBeGreaterThan(drainStart);
    expect(output.slice(0, drainStart)).toContain('command=coral-cli backend status');
    expect(output.slice(drainStart, guidanceStart)).not.toContain('command=');
    expect(operatorArtifactLines(output.slice(guidanceStart))).toEqual(['command=coral-cli backend status']);
  });

  it.each(['ok', 'draining'] as const)(
    'does not render operatorExit in otherwise identical %s provider-set output',
    (healthStatus) => {
      const setIdentity = {
        buildSetId: '11111111-1111-4111-8111-111111111111',
        hostFingerprint: 'a'.repeat(64),
        proxyInstanceId: '22222222-2222-4222-8222-222222222222',
      };
      const variants: readonly ProviderProxySetOperatorExit[] = [
        { kind: 'none' },
        { kind: 'gated', remainingMs: 1200.2 },
        { kind: 'contain' },
        { kind: 'abandon' },
        ...PROVIDER_PROXY_SET_OPERATOR_EXIT_REFUSAL_GROUNDS.map((ground) => ({ kind: 'refused', ground }) as const),
      ];
      const outputs = variants.map((operatorExit) =>
        formatBackendStatus(
          runningBackendStatus(
            {
              providerProxySets: [
                {
                  setIdentity,
                  setToken: encodeProviderProxySetAddress(setIdentity),
                  liveClaims: 0,
                  operatorExit,
                  autonomousDisposition: { kind: 'unavailable' },
                  holds: [],
                },
              ],
            },
            {
              status: healthStatus,
              kernel: {
                phase: healthStatus === 'draining' ? 'draining' : 'running',
                readyAt: healthStatus === 'draining' ? null : 1_700_000_000_000,
              },
            },
          ),
          { kind: 'absent' },
          null,
        ),
      );

      expect([...new Set(outputs)]).toHaveLength(1);
      expect(outputs[0]).not.toContain('operatorExit');
      expect(outputs[0]).not.toContain('1200.2');
      for (const ground of PROVIDER_PROXY_SET_OPERATOR_EXIT_REFUSAL_GROUNDS) {
        expect(outputs[0]).not.toContain(ground);
      }
    },
  );
});

describe('backend status provider proxy dispositions', () => {
  it('reports automatic set dispositions without soliciting containment or abandonment', () => {
    const setIdentity = {
      buildSetId: '11111111-1111-4111-8111-111111111111',
      hostFingerprint: 'a'.repeat(64),
      proxyInstanceId: '22222222-2222-4222-8222-222222222222',
    };
    const setToken = encodeProviderProxySetAddress(setIdentity);
    const hold = {
      disposition: 'held',
      incidentReason: 'control_channel_reattaching',
      waitingFor: 'control-reattachment',
    } as const;
    const base = {
      status: 'ok',
      kernel: { phase: 'running', readyAt: 1_700_000_000_000 },
      version: '0.10.4',
      bundleHash: 'bundle-hash',
      flavor: 'prod',
      namespace: 'test-ns',
      instanceId: 'instance-1',
      uptimeMs: 1_000,
      active: 0,
      activeJobs: 0,
      queueDepth: 0,
      inflightRequests: 0,
      textProjectionState: 'idle',
      components: [],
    } as const;
    const status = runningStatusFromHealthPayload({
      ...base,
      diagnostics: {
        providerProxySets: [
          {
            setIdentity,
            setToken,
            liveClaims: 0,
            operatorExit: { kind: 'none' },
            autonomousDisposition: { kind: 'inactive' },
            holds: [hold],
          },
          {
            setIdentity,
            setToken,
            liveClaims: 0,
            operatorExit: { kind: 'gated', remainingMs: 1200.2 },
            autonomousDisposition: {
              kind: 'control-or-containment',
              owner: 'coordinator',
              boundMs: 60_000,
              retryAction: 'recover-control-or-observe-exact-containment',
              refusalSuccessor: 'automatic-retry',
              terminalExit: 'control-reattached-or-containment-absent',
            },
            holds: [hold],
          },
          {
            setIdentity,
            setToken,
            liveClaims: 0,
            operatorExit: { kind: 'contain' },
            autonomousDisposition: {
              kind: 'exact-containment',
              owner: 'coordinator',
              boundMs: 60_000,
              retryAction: 'observe-exact-containment',
              refusalSuccessor: 'automatic-retry',
              terminalExit: 'containment-absent',
            },
            holds: [hold],
          },
          {
            setIdentity,
            setToken,
            liveClaims: 0,
            operatorExit: { kind: 'refused', ground: 'enforcer-unobservable' },
            autonomousDisposition: {
              kind: 'exact-containment',
              owner: 'coordinator',
              boundMs: 60_000,
              retryAction: 'observe-exact-containment',
              refusalSuccessor: 'automatic-retry',
              terminalExit: 'containment-absent',
            },
            holds: [hold],
          },
          {
            setIdentity,
            setToken,
            liveClaims: 0,
            operatorExit: { kind: 'refused', ground: 'representation-release-fatal' },
            autonomousDisposition: {
              kind: 'representation-release-fatal',
              owner: 'coordinator',
              boundMs: 60_000,
              retryAction: 'drop-representation-slot',
              refusalSuccessor: 'not-refusable',
              terminalExit: 'representation-released',
            },
            holds: [hold],
          },
        ],
      },
    });
    const rendered = formatBackendStatus(status, { kind: 'absent' }, null);
    expect(rendered).toContain('disposition=inactive waitingFor=control-reattachment');
    // The one line printed per set is all a reader of this output gets, so a fatally settled release may not
    // print the live release's retry action or its automatic-retry successor: nothing retries it.
    expect(rendered).toContain(
      'disposition=automatic owner=coordinator boundMs=60000 retryAction=drop-representation-slot refusalSuccessor=not-refusable terminalExit=representation-released',
    );
    expect(rendered).not.toContain('retryAction=release-representation');
    expect(rendered).toContain(
      'disposition=automatic owner=coordinator boundMs=60000 retryAction=recover-control-or-observe-exact-containment refusalSuccessor=automatic-retry terminalExit=control-reattached-or-containment-absent',
    );
    expect(rendered).toContain(
      'disposition=automatic owner=coordinator boundMs=60000 retryAction=observe-exact-containment refusalSuccessor=automatic-retry terminalExit=containment-absent',
    );
    expect(rendered).not.toContain('provider-proxy-set contain');
    expect(rendered).not.toContain('provider-proxy-set abandon');
  });

  it('renders retained set evidence and exits 75 when any structurally identified row was skipped', async () => {
    const tokens = {
      first: encodeProviderProxySetAddress({
        buildSetId: '11111111-1111-4111-8111-111111111111',
        hostFingerprint: 'a'.repeat(64),
        proxyInstanceId: '22222222-2222-4222-8222-222222222222',
      }),
      second: encodeProviderProxySetAddress({
        buildSetId: '33333333-3333-4333-8333-333333333333',
        hostFingerprint: 'b'.repeat(64),
        proxyInstanceId: '44444444-4444-4444-8444-444444444444',
      }),
      third: encodeProviderProxySetAddress({
        buildSetId: '55555555-5555-4555-8555-555555555555',
        hostFingerprint: 'c'.repeat(64),
        proxyInstanceId: '66666666-6666-4666-8666-666666666666',
      }),
      fourth: encodeProviderProxySetAddress({
        buildSetId: '77777777-7777-4777-8777-777777777777',
        hostFingerprint: 'd'.repeat(64),
        proxyInstanceId: '88888888-8888-4888-8888-888888888888',
      }),
    };
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
      components: [],
      diagnostics: {
        providerProxySets: [
          {
            setIdentity: {
              buildSetId: '11111111-1111-4111-8111-111111111111',
              hostFingerprint: 'a'.repeat(64),
              proxyInstanceId: '22222222-2222-4222-8222-222222222222',
            },
            setToken: tokens.first,
            liveClaims: 0,
            operatorExit: { kind: 'contain' },
            autonomousDisposition: {
              kind: 'exact-containment',
              owner: 'coordinator',
              boundMs: 60_000,
              retryAction: 'observe-exact-containment',
              refusalSuccessor: 'automatic-retry',
              terminalExit: 'containment-absent',
            },
            holds: [
              {
                disposition: 'awaiting-containment-absence',
                role: 'guardian',
                method: 'guardian.heartbeat.v1',
                incidentReason: 'method-not-found',
                waitingFor: 'independent-containment-absence',
                enforcerObservations: [
                  { role: 'guardian', observation: 'alive' },
                  { role: 'reaper', observation: 'unknown' },
                ],
              },
            ],
          },
          {
            setIdentity: {
              buildSetId: '33333333-3333-4333-8333-333333333333',
              hostFingerprint: 'b'.repeat(64),
              proxyInstanceId: '44444444-4444-4444-8444-444444444444',
            },
            setToken: tokens.second,
            liveClaims: 2,
            operatorExit: { kind: 'none' },
            autonomousDisposition: { kind: 'inactive' },
            holds: [
              {
                disposition: 'held',
                role: 'proxy',
                cause: 'invalid-unattributable-frame',
                attempts: 3,
                elapsedMs: 1250,
                boundMs: 23000,
                incidentReason: 'control_channel_reattaching',
                waitingFor: 'control-reattachment',
              },
              {
                disposition: 'operator-exit-refused',
                incidentReason: 'operator_exit_deadline_pending',
                waitingFor: 'set-adoption-deadline',
              },
            ],
          },
          {
            setIdentity: {
              buildSetId: '55555555-5555-4555-8555-555555555555',
              hostFingerprint: 'c'.repeat(64),
              proxyInstanceId: '66666666-6666-4666-8666-666666666666',
            },
            setToken: tokens.third,
            liveClaims: 0,
            operatorExit: { kind: 'contain' },
            holds: [
              {
                disposition: 'released-by-successor',
                incidentReason: 'successor-adopted',
                waitingFor: 'successor-acknowledgement',
              },
            ],
          },
          {
            setIdentity: {
              buildSetId: '77777777-7777-4777-8777-777777777777',
              hostFingerprint: 'd'.repeat(64),
              proxyInstanceId: '88888888-8888-4888-8888-888888888888',
            },
            setToken: tokens.fourth,
            liveClaims: 0,
            holds: [
              {
                disposition: 'held',
                incidentReason: 'successor-adopted',
                waitingFor: 'successor-acknowledgement',
              },
            ],
          },
        ],
      },
    };
    const status = runningStatusFromHealthPayload(produced);

    expect(formatBackendStatus(status, { kind: 'absent' }, null)).toContain(
      [
        'Provider proxy sets:',
        `  set=${tokens.first} liveClaims=0`,
        '    identity buildSetId=11111111-1111-4111-8111-111111111111 proxyInstanceId=22222222-2222-4222-8222-222222222222 hostFingerprint=' +
          'a'.repeat(64),
        '    - disposition=awaiting-containment-absence subject=guardian guardian.heartbeat.v1 incident=method-not-found waitingFor=independent-containment-absence enforcers=guardian:alive,reaper:unknown',
        '    disposition=automatic owner=coordinator boundMs=60000 retryAction=observe-exact-containment refusalSuccessor=automatic-retry terminalExit=containment-absent',
      ].join('\n'),
    );
    expect(formatBackendStatus(status, { kind: 'absent' }, null)).toContain(
      [
        `  set=${tokens.second} liveClaims=2`,
        '    identity buildSetId=33333333-3333-4333-8333-333333333333 proxyInstanceId=44444444-4444-4444-8444-444444444444 hostFingerprint=' +
          'b'.repeat(64),
        '    - disposition=held subject=proxy incident=control_channel_reattaching waitingFor=control-reattachment cause=invalid-unattributable-frame attempts=3 elapsedMs=1250 boundMs=23000',
        '    - disposition=operator-exit-refused incident=operator_exit_deadline_pending waitingFor=set-adoption-deadline',
        '    disposition=inactive waitingFor=control-reattachment,set-adoption-deadline',
      ].join('\n'),
    );
    expect(formatBackendStatus(status, { kind: 'absent' }, null)).toContain(
      'Provider proxy set rows this build could not read: 2; backend status is not showing their dispositions, causes, or waiting conditions.',
    );
    const rendered = formatBackendStatus(status, { kind: 'absent' }, null);
    expect(rendered.split(`  set=${tokens.second}`).length - 1).toBe(1);
    expect(rendered).not.toContain(`action=coral-cli backend provider-proxy-set contain ${tokens.second}`);
    expect(rendered).toContain(
      '    - disposition=operator-exit-refused incident=operator_exit_deadline_pending waitingFor=set-adoption-deadline',
    );
    expect(rendered).toContain(
      `skipped candidate reason=unsupported-row rawSetToken=${JSON.stringify(tokens.third)} rawSetIdentity buildSetId="55555555-5555-4555-8555-555555555555"`,
    );
    expect(rendered).toContain(
      `skipped candidate reason=unsupported-row rawSetToken=${JSON.stringify(tokens.fourth)} rawSetIdentity buildSetId="77777777-7777-4777-8777-777777777777"`,
    );

    const operations: BackendStatusCommandOperations = {
      inspectReadiness: () => ({ kind: 'no-legacy' }),
      getStatus: async () => status,
      getLiveHandoffResult: () => null,
      getRoutingStatus: async () => ({ kind: 'absent' }),
    };
    const program = new Command();
    program.exitOverride();
    registerBackendCommands(program, { storeReset, backendStatus: operations });

    await program.parseAsync(['node', 'coral-cli', 'backend', 'status']);

    expect(process.exitCode).toBe(75);
    expect(stdout).toContain('No containment or abandonment command is available because this build cannot verify');
  });

  it('prints the automatic recovery exit for an acquisition publication hold', async () => {
    const setIdentity = {
      buildSetId: '99999999-9999-4999-8999-999999999999',
      hostFingerprint: 'e'.repeat(64),
      proxyInstanceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    };
    const setToken = encodeProviderProxySetAddress(setIdentity);
    const status = runningStatusFromHealthPayload({
      status: 'ok',
      kernel: { phase: 'running', readyAt: 1_700_000_000_000 },
      version: '0.10.4',
      bundleHash: 'bundle-hash',
      flavor: 'prod',
      namespace: 'test-ns',
      instanceId: 'instance-1',
      uptimeMs: 1_000,
      active: 0,
      activeJobs: 0,
      queueDepth: 0,
      inflightRequests: 0,
      textProjectionState: 'idle',
      components: [],
      diagnostics: {
        providerProxySets: [
          {
            setIdentity,
            setToken,
            liveClaims: 0,
            operatorExit: { kind: 'none' },
            autonomousDisposition: {
              kind: 'publication-recovery',
              owner: 'coordinator',
              boundMs: 60_000,
              retryAction: 'confirm-publication-or-release-control',
              refusalSuccessor: 'automatic-retry',
              terminalExit: 'publication-confirmed-or-control-released',
            },
            holds: [
              {
                disposition: 'held',
                incidentReason: 'publication_result_unknown',
                waitingFor: 'publication-confirmation-or-control-release',
              },
            ],
          },
        ],
      },
    });
    expect(status.health.skippedProviderProxySetRows).toBe(0);

    const operations: BackendStatusCommandOperations = {
      inspectReadiness: () => ({ kind: 'no-legacy' }),
      getStatus: async () => status,
      getLiveHandoffResult: () => null,
      getRoutingStatus: async () => ({ kind: 'absent' }),
    };
    const program = new Command();
    program.exitOverride();
    registerBackendCommands(program, { storeReset, backendStatus: operations });

    await program.parseAsync(['node', 'coral-cli', 'backend', 'status']);

    expect(stdout).toContain(
      'disposition=automatic owner=coordinator boundMs=60000 retryAction=confirm-publication-or-release-control refusalSuccessor=automatic-retry terminalExit=publication-confirmed-or-control-released',
    );
    expect(stdout).not.toContain(`coral-cli backend provider-proxy-set contain ${setToken}`);
    expect(process.exitCode).toBe(75);
  });
});

describe('backend startup diagnostic classification', () => {
  const now = Date.parse('2026-08-02T12:00:00.000Z');
  // The records below carry no build identity, so authorship stays unprovable however this build proves its own.
  const provenSelfIdentity = (): SetupErrorAuthorIdentity => ({ bundleHash: '0123456789abcdef', namespace: 'ns-self' });

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
        provenSelfIdentity,
      ),
    ).toEqual({
      status: 'recent_failure',
      phase: 'startup_failed',
      retryable: false,
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
      provenSelfIdentity,
    );
    if (classified === null) throw new Error('expected recent startup failure');
    const status: BackendStatusCommandOperations = {
      inspectReadiness: () => ({ kind: 'no-legacy' }),
      getStatus: async () => classified,
      getLiveHandoffResult: () => null,
      getRoutingStatus: async () => ({ kind: 'absent' }),
      readProviderProxySetHolderStatusDirect: noDirectProviderProxySetHolders,
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
        provenSelfIdentity,
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
        provenSelfIdentity,
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
        provenSelfIdentity,
        Date.parse('2026-08-02T11:59:00.000Z'),
        4242,
      ),
    ).toBeNull();
  });
});
