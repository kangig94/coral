import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createShutdownRecoveryCommandOperations,
  registerBackendCommands,
  type BackendStatusCommandOperations,
  type DirectProviderProxySetHolderStatus,
  type ShutdownRecoveryCommandOperations,
  type StoreResetCommandOperations,
} from '#src/cli/commands/backend.js';
import type { Runtime } from '#src/runtime/ports.js';
import type { createIpcClient, IpcClient } from '#src/transport/ipc/client.js';
import {
  formatBackendStatus,
  formatHandoffContinuationReason,
  formatHandoffRoutingStatus,
  formatProviderProxySetContainResult,
} from '#src/cli/format/backend.js';
import { formatHandoffPublicationIncident } from '#src/cli/format/handoff-publication.js';
import {
  documentedCoralSetupError,
  type DocumentedCoralSetupErrorCode,
  type SetupErrorAuthorIdentity,
} from '#src/runtime/errors.js';
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
  type HandoffRoutingStatusReadResult,
} from '#src/coordinator/handoff-routing/status.js';
import { incumbentIdentitySummarySchema } from '#src/coordinator/handoff-routing/policy.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';
import { createRecoveryComponent } from '#src/coordinator/runtime-components/recovery-component.js';
import { createRuntimeComponentRegistry } from '#src/coordinator/runtime-components/registry.js';
import { RecoveryQuarantineStore } from '#src/recovery/quarantine.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { applyBundledStoreSchema } from '#src/store/db.js';
import { handoffRoutingStatusGeneration } from '#src/store/handoff-routing-status-store/index.js';
import { parseBackendHealth } from '#src/transport/http/backend/health.js';
import { statusFromStartupDiagnostic, type BackendStatusFull } from '#src/transport/http/backend/status.js';
import type { HealthSnapshot } from '#src/transport/server-ports.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { encodeProviderProxySetAddress } from '#src/provider-proxy/set-address.js';
import { executeRenderedCommand } from '#tests/helpers/rendered-command.js';

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
  const { namespace: _namespace, status: _status, ...health } = parsed.health;
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

const storeReset: StoreResetCommandOperations = {
  list: () => ({ incidents: [] }),
  report: async () => {
    throw new Error('not used');
  },
  discard: async () => {
    throw new Error('not used');
  },
};

const noDirectProviderProxySetHolders = async () => [] as const;

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

describe('backend shutdown recovery commands', () => {
  it('dials the recorded draining coordinator directly with its boot credential', async () => {
    const request = vi.fn(async () => ({
      kind: 'not-offered' as const,
      subject: 'app-server-handoff-quiesce' as const,
    }));
    const createClient = vi.fn<typeof createIpcClient>(() => ({ request }) as unknown as IpcClient);
    const runtime = {
      time: TEST_TIME,
      storage: {
        readFileSync: vi.fn(() =>
          JSON.stringify({
            pid: 4_242,
            port: 4_242,
            socketPath: '/run/draining.sock',
            bundleHash: 'bundle',
            flavor: 'prod',
            namespace: 'namespace',
            startedAt: 1,
            token: 'token',
            bootToken: 'draining-boot-token',
            host: '127.0.0.1',
            version: 'test',
            instanceId: 'draining-instance',
          }),
        ),
      },
      env: { platform: () => process.platform },
      paths: {
        coral: {
          coordinator: {
            infoFile: '/run/coordinator.json',
            runDir: '/run',
          },
        },
      },
    } as unknown as Runtime;
    const operations = createShutdownRecoveryCommandOperations({ runtime, createClient });

    await expect(operations.abandon('app-server-handoff-quiesce')).resolves.toEqual({
      kind: 'not-offered',
      subject: 'app-server-handoff-quiesce',
    });

    expect(createClient).toHaveBeenCalledWith('/run/draining.sock', TEST_TIME, {
      kind: 'boot',
      token: 'draining-boot-token',
    });
    expect(request).toHaveBeenCalledWith(
      'coordinator.shutdown_obligation.abandon',
      { subject: 'app-server-handoff-quiesce' },
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    );
  });

  it('renders durable abandoned-unconfirmed status after the coordinator exits', async () => {
    const shutdownRecovery: ShutdownRecoveryCommandOperations = {
      abandon: vi.fn(),
      status: () => ({
        kind: 'available',
        path: '/run/shutdown-abandonment-status.v1.json',
        status: {
          version: 1,
          entries: [
            {
              subject: 'app-server-handoff-quiesce',
              instanceId: 'exited-instance',
              recordedAt: '2026-09-07T00:00:00.000Z',
              disposition: 'abandoned-unconfirmed',
              detail: 'App-server write completion was not observed; the write may or may not have landed.',
              statusPath: '/run/shutdown-abandonment-status.v1.json',
            },
          ],
        },
      }),
    };
    const program = new Command();
    program.exitOverride();
    registerBackendCommands(program, { storeReset, shutdownRecovery });

    await program.parseAsync(['node', 'coral-cli', 'backend', 'shutdown-recovery', 'status']);

    expect(stdout).toContain('subject=app-server-handoff-quiesce disposition=abandoned-unconfirmed');
    expect(stdout).toContain('This is not evidence of completion or absence.');
    expect(stderr).toBe('');
    expect(process.exitCode).toBe(0);
  });

  it('returns success only for an accepted durable abandonment receipt', async () => {
    const shutdownRecovery: ShutdownRecoveryCommandOperations = {
      abandon: vi.fn<ShutdownRecoveryCommandOperations['abandon']>(async () => ({
        kind: 'accepted',
        receipt: {
          subject: 'app-server-handoff-quiesce',
          instanceId: 'held-instance',
          recordedAt: '2026-09-07T00:00:00.000Z',
          disposition: 'abandoned-unconfirmed',
          detail: 'App-server write completion was not observed; the write may or may not have landed.',
          statusPath: '/run/shutdown-abandonment-status.v1.json',
        },
      })),
      status: () => ({ kind: 'absent', path: '/run/shutdown-abandonment-status.v1.json' }),
    };
    const program = new Command();
    program.exitOverride();
    registerBackendCommands(program, { storeReset, shutdownRecovery });

    await program.parseAsync([
      'node',
      'coral-cli',
      'backend',
      'shutdown-recovery',
      'abandon',
      'app-server-handoff-quiesce',
    ]);

    expect(shutdownRecovery.abandon).toHaveBeenCalledWith('app-server-handoff-quiesce');
    expect(stdout).toContain('Disposition: abandoned-unconfirmed');
    expect(stdout).toContain('This is not evidence of completion or absence.');
    expect(stderr).toBe('');
    expect(process.exitCode).toBe(0);
  });

  it('returns a refusal exit when the held shutdown did not offer the subject', async () => {
    const shutdownRecovery: ShutdownRecoveryCommandOperations = {
      abandon: vi.fn<ShutdownRecoveryCommandOperations['abandon']>(async (subject) => ({
        kind: 'not-offered',
        subject,
      })),
      status: () => ({ kind: 'absent', path: '/run/shutdown-abandonment-status.v1.json' }),
    };
    const program = new Command();
    program.exitOverride();
    registerBackendCommands(program, { storeReset, shutdownRecovery });

    await program.parseAsync([
      'node',
      'coral-cli',
      'backend',
      'shutdown-recovery',
      'abandon',
      'provider-host-shutdown',
    ]);

    expect(stdout).toBe('');
    expect(stderr).toContain('current held shutdown did not offer that exact action');
    expect(process.exitCode).toBe(1);
  });

  it('returns undetermined when durable status cannot be read or written', async () => {
    const shutdownRecovery: ShutdownRecoveryCommandOperations = {
      abandon: vi.fn<ShutdownRecoveryCommandOperations['abandon']>(async (subject) => ({
        kind: 'status-write-refused',
        subject,
        detail: 'atomic durable status publication was not confirmed',
      })),
      status: () => ({
        kind: 'unreadable',
        path: '/run/shutdown-abandonment-status.v1.json',
        detail: 'invalid JSON',
      }),
    };
    const program = new Command();
    program.exitOverride();
    registerBackendCommands(program, { storeReset, shutdownRecovery });

    await program.parseAsync(['node', 'coral-cli', 'backend', 'shutdown-recovery', 'status']);
    expect(stderr).toContain('status is unreadable');
    expect(process.exitCode).toBe(75);

    stdout = '';
    stderr = '';
    process.exitCode = undefined;
    const abandonProgram = new Command();
    abandonProgram.exitOverride();
    registerBackendCommands(abandonProgram, { storeReset, shutdownRecovery });
    await abandonProgram.parseAsync([
      'node',
      'coral-cli',
      'backend',
      'shutdown-recovery',
      'abandon',
      'provider-host-shutdown',
    ]);
    expect(stderr).toContain('durable status was not confirmed');
    expect(process.exitCode).toBe(75);
  });
});

describe('backend status generation readiness', () => {
  it.each([
    [{ kind: 'unreadable', reason: 'invalid-json' } as const, 'Routing status is unreadable (invalid-json).'],
    [{ kind: 'foreign-generation', generation: 2 } as const, 'Routing status generation 2 belongs to another address.'],
  ])('names discard as the successor for a durable routing-status hold', async (status, summary) => {
    const rendered = formatHandoffRoutingStatus(status) ?? '';
    expect(rendered).toBe(
      `${summary}\nNext step: run the discard command below.\ncommand=coral-cli backend routing-status discard`,
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
        'Next step: inspect backend status again without discarding. If this persists, repair the reported storage condition; discard is not permitted because this read did not establish a discardable classification.',
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
        storedProductVersion: '0.9.16',
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
      'Legacy Coral history remains at /state/data (stored Coral version 0.9.16) and is left untouched. This generation initializes its own state at /state/gen2/data.\n',
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
        'Next step: run the shutdown command below, then rerun a mutating command; it attempts startup or handoff from this installation.',
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
      'Next step: run the resolution command below.',
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
        'Routing invocation retired-invocation: retired (selection-evicted-at-capacity; terminal recorded: no).\nSelected routing: continued current (same-build-set: 123e4567-e89b-42d3-a456-426614174000).\nNext step: run the resolution command below to acknowledge the retained capacity eviction.\ncommand=coral-cli backend routing-status resolve --invocation retired-invocation',
    },
    {
      name: 'capacity eviction with a terminal',
      retirementCause: 'selection-evicted-at-capacity',
      terminalExisted: true,
      expected:
        'Routing invocation retired-invocation: retired (selection-evicted-at-capacity; terminal recorded: yes).\nSelected routing: continued current (same-build-set: 123e4567-e89b-42d3-a456-426614174000).\nNext step: run the resolution command below to acknowledge the retained capacity eviction.\ncommand=coral-cli backend routing-status resolve --invocation retired-invocation',
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
        'Next step: run the shutdown command below, then run any mutating Coral command (or start a Claude Code session); it attempts startup or handoff from the current installation.',
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
        'Next step: follow the daemon-status remediation above; do not proceed while the backend status command exits 75.',
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
        'Next step: follow the daemon-status remediation above; do not proceed while the backend status command exits 75.',
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
        'Next step: run the shutdown command below, then rerun a mutating command; it attempts startup or handoff from this installation.',
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
        'Next step: run the shutdown command below, then rerun a mutating command; it attempts startup or handoff from this installation.',
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

describe('backend status provider proxy dispositions', () => {
  it('renders every asserted set exit and shares refusal guidance with the command result', async () => {
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
          { setIdentity, setToken, liveClaims: 0, operatorExit: { kind: 'none' }, holds: [hold] },
          { setIdentity, setToken, liveClaims: 0, operatorExit: { kind: 'gated', remainingMs: 1200.2 }, holds: [hold] },
          { setIdentity, setToken, liveClaims: 0, operatorExit: { kind: 'contain' }, holds: [hold] },
          {
            setIdentity,
            setToken,
            liveClaims: 0,
            operatorExit: { kind: 'refused', ground: 'enforcer-unobservable' },
            holds: [hold],
          },
        ],
      },
    });
    const rendered = formatBackendStatus(status, { kind: 'absent' }, null);
    const commandGuidance = formatProviderProxySetContainResult({
      kind: 'enforcer-unobservable',
      setIdentity,
      enforcerObservations: [
        { role: 'guardian', observation: 'unknown' },
        { role: 'reaper', observation: 'absent' },
      ],
      effect: { signalsSent: [], containmentAbsent: false, representationAction: 'none' },
    })
      .split('\n')
      .find((line) => line.startsWith('Next step:'));

    expect(rendered).toContain('action=wait for control-reattachment');
    expect(rendered).toContain(`action=wait ~1201ms for the operator-exit gate, then contain ${setToken}`);
    expect(rendered).toContain(`action=coral-cli backend provider-proxy-set contain ${setToken}`);
    if (commandGuidance === undefined) throw new Error('Expected refusal guidance');
    expect(rendered).toContain(commandGuidance);
    const dispatched: RecordedBackendCommand[] = [];
    const program = backendCommandProgram(dispatched);
    await executeRenderedCommand(program, rendered, { label: 'action', includes: 'coral-cli' });
    await executeRenderedCommand(program, rendered, { label: 'command', includes: ' contain ' });
    await executeRenderedCommand(program, rendered, { label: 'command', includes: ' abandon ' });
    expect(dispatched).toEqual([
      { kind: 'provider-proxy-set-contain', token: setToken },
      { kind: 'provider-proxy-set-contain', token: setToken },
      { kind: 'provider-proxy-set-abandon', token: setToken },
    ]);
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
        `    action=coral-cli backend provider-proxy-set contain ${tokens.first}`,
      ].join('\n'),
    );
    expect(formatBackendStatus(status, { kind: 'absent' }, null)).toContain(
      [
        `  set=${tokens.second} liveClaims=2`,
        '    identity buildSetId=33333333-3333-4333-8333-333333333333 proxyInstanceId=44444444-4444-4444-8444-444444444444 hostFingerprint=' +
          'b'.repeat(64),
        '    - disposition=held subject=proxy incident=control_channel_reattaching waitingFor=control-reattachment cause=invalid-unattributable-frame attempts=3 elapsedMs=1250 boundMs=23000',
        '    - disposition=operator-exit-refused incident=operator_exit_deadline_pending waitingFor=set-adoption-deadline',
        '    action=wait for control-reattachment,set-adoption-deadline',
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
      'action=wait; Coral retries publication automatically until publication is confirmed or control is released.',
    );
    expect(stdout).not.toContain(`coral-cli backend provider-proxy-set contain ${setToken}`);
    expect(process.exitCode).toBe(75);
  });
});

describe('backend startup diagnostic classification', () => {
  const now = Date.parse('2026-08-02T12:00:00.000Z');
  // The records below carry no build identity, so authorship stays unprovable however this build proves its own.
  const provenSelfIdentity = (): SetupErrorAuthorIdentity => ({ bundleHash: '0123456789abcdef', namespace: 'ns-self' });

  const authored = (
    code: DocumentedCoralSetupErrorCode,
    context?: Record<string, unknown>,
  ): { userMessage: string; remediation: string } => {
    const error = documentedCoralSetupError(code, context);
    return { userMessage: error.userMessage, remediation: error.remediation };
  };

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

  it('accepts and carries a retryable startup diagnostic', () => {
    expect(
      statusFromStartupDiagnostic(
        {
          schemaVersion: 1,
          phase: 'startup_failed',
          state: 'stopped_with_diagnostic',
          retryable: true,
          pid: 4242,
          recordedAt: '2026-08-02T11:59:30.000Z',
          exitCode: 75,
          error: {
            kind: 'coral_setup_error',
            code: 'store_open_contended',
            userMessage: 'The current-generation store could not be opened because it is in use.',
            remediation: 'Wait for the other store user to release the SQLite lock, then retry.',
          },
        },
        now,
        provenSelfIdentity,
      ),
    ).toEqual({
      status: 'recent_failure',
      phase: 'startup_failed',
      retryable: true,
      setupError: {
        kind: 'documented',
        code: 'store_open_contended',
        userMessage: authored('store_open_contended').userMessage,
        remediation: authored('store_open_contended').remediation,
      },
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
            context: { flavor: 'prod', version: '0.11.0' },
          },
        },
        now,
        provenSelfIdentity,
      ),
    ).toEqual({
      status: 'recent_failure',
      phase: 'startup_failed',
      retryable: false,
      setupError: {
        kind: 'documented',
        code: 'store_newer_incompatible',
        userMessage: authored('store_newer_incompatible', { flavor: 'prod', version: '0.11.0' }).userMessage,
        remediation: authored('store_newer_incompatible', { flavor: 'prod', version: '0.11.0' }).remediation,
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
