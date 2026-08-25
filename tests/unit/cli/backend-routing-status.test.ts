import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  registerBackendCommands,
  type HandoffRoutingStatusCommandOperations,
  type HandoffRoutingStatusQuarantineCommandOperations,
} from '#src/cli/commands/backend.js';
import { formatHandoffRoutingResolveResult } from '#src/cli/format/backend.js';
import { parseHandoffRepairOperation } from '#src/coordinator/handoff-repair-operation.js';
import {
  handoffRoutingStatusStoreSchema,
  type HandoffRoutingResolveResult,
} from '#src/coordinator/handoff-routing-status.js';
import { handoffRoutingStatusGeneration } from '#src/store/handoff-routing-status-store.js';

const INVOCATION_ID = '123e4567-e89b-42d3-a456-426614174000';
const HANDOFF_ROUTING_STATUS_GENERATION = handoffRoutingStatusGeneration(handoffRoutingStatusStoreSchema());

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe('backend routing-status resolve grammar', () => {
  it.each([
    ['separated', ['backend', 'routing-status', 'resolve', '--invocation', INVOCATION_ID]],
    ['equals', ['backend', 'routing-status', 'resolve', `--invocation=${INVOCATION_ID}`]],
    [
      'force after invocation',
      ['backend', 'routing-status', 'resolve', '--invocation', INVOCATION_ID, '--force-unobservable'],
    ],
    [
      'force before invocation',
      ['backend', 'routing-status', 'resolve', '--force-unobservable', `--invocation=${INVOCATION_ID}`],
    ],
  ])('parses %s syntax', (_name, tokens) => {
    expect(parseHandoffRepairOperation(['node', 'coral-cli', ...tokens])).toEqual({
      kind: 'routing-status-resolve',
      invocationId: INVOCATION_ID,
      forceUnobservable: tokens.includes('--force-unobservable'),
    });
  });

  it.each([
    ['missing invocation', []],
    ['missing separated value', ['--invocation']],
    ['option as separated value', ['--invocation', '--force-unobservable']],
    ['unknown option', ['--invocation', INVOCATION_ID, '--unknown']],
    ['unknown operand', ['--invocation', INVOCATION_ID, 'extra']],
    ['noncanonical invocation', ['--invocation', INVOCATION_ID.toUpperCase()]],
    ['duplicate separated invocation', ['--invocation', INVOCATION_ID, '--invocation', INVOCATION_ID]],
    [
      'duplicate mixed invocation',
      [`--invocation=${INVOCATION_ID}`, '--invocation', '223e4567-e89b-42d3-a456-426614174000'],
    ],
    ['duplicate force', ['--invocation', INVOCATION_ID, '--force-unobservable', '--force-unobservable']],
  ])('rejects %s', (_name, options) => {
    expect(
      parseHandoffRepairOperation(['node', 'coral-cli', 'backend', 'routing-status', 'resolve', ...options]),
    ).toBeNull();
  });

  it('is bidirectionally equivalent to the registered Commander action', async () => {
    const secondInvocationId = '223e4567-e89b-42d3-a456-426614174000';
    const cases = [
      ['--invocation', INVOCATION_ID],
      [`--invocation=${INVOCATION_ID}`],
      ['--force-unobservable', '--invocation', INVOCATION_ID],
      ['--invocation', INVOCATION_ID, '--force-unobservable'],
      ['--invocation', INVOCATION_ID, '--invocation', INVOCATION_ID],
      [`--invocation=${INVOCATION_ID}`, '--invocation', secondInvocationId],
      ['--invocation', INVOCATION_ID, '--force-unobservable', '--force-unobservable'],
      [],
      ['--invocation'],
      ['--invocation', '--force-unobservable'],
      ['--invocation', INVOCATION_ID, '--'],
      ['--invocation', INVOCATION_ID, '--unknown'],
      ['--invocation', INVOCATION_ID, 'extra'],
      ['--invocation', INVOCATION_ID.toUpperCase()],
    ];

    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    for (const options of cases) {
      const argv = ['node', 'coral-cli', 'backend', 'routing-status', 'resolve', ...options];
      const parsed = parseHandoffRepairOperation(argv);
      const requests: unknown[] = [];
      const routingStatus: HandoffRoutingStatusCommandOperations = {
        resolve: async (request) => {
          requests.push(request);
          return {
            kind: 'resolved',
            invocationId: request.invocationId,
            reason: 'owner-absent',
            sequence: 1,
          };
        },
        discard: () => ({ kind: 'refused', status: { kind: 'absent' } }),
      };
      const program = new Command();
      program.exitOverride();
      program.configureOutput({ writeErr: () => undefined });
      registerBackendCommands(program, { routingStatus });
      await program.parseAsync(argv).catch(() => undefined);
      expect(requests, options.join(' ')).toEqual(parsed === null ? [] : [parsed]);
      process.exitCode = undefined;
    }
  });

  it('documents the force override safety precondition in command help', () => {
    const program = new Command();
    registerBackendCommands(program, {
      routingStatus: {
        resolve: async () => {
          throw new Error('not used');
        },
        discard: async () => ({ kind: 'refused', status: { kind: 'absent' } }),
      },
    });
    const backend = program.commands.find((command) => command.name() === 'backend');
    const routingStatus = backend?.commands.find((command) => command.name() === 'routing-status');
    const resolve = routingStatus?.commands.find((command) => command.name() === 'resolve');

    const help = resolve?.helpInformation();
    expect(help).toContain('Default: false; requires external owner verification');
    expect(help).toContain('cannot override deadline-expired');
  });

  it.each<Readonly<{ result: HandoffRoutingResolveResult; exitCode: 0 | 1 | 70 | 75 }>>([
    {
      result: { kind: 'resolved', invocationId: INVOCATION_ID, reason: 'owner-absent', sequence: 1 },
      exitCode: 0,
    },
    {
      result: { kind: 'acknowledged-capacity-eviction', invocationId: INVOCATION_ID, selectionSequence: 1 },
      exitCode: 0,
    },
    { result: { kind: 'already-terminal', invocationId: INVOCATION_ID }, exitCode: 0 },
    { result: { kind: 'stale', invocationId: INVOCATION_ID }, exitCode: 1 },
    { result: { kind: 'live-owner', invocationId: INVOCATION_ID }, exitCode: 1 },
    {
      result: { kind: 'unauthorized-unobservable', invocationId: INVOCATION_ID, cause: 'deadline-expired' },
      exitCode: 75,
    },
    {
      result: { kind: 'status-unavailable', status: { kind: 'unreadable', reason: 'invalid-shape' } },
      exitCode: 75,
    },
    {
      result: {
        kind: 'not-published',
        invocationId: INVOCATION_ID,
        cause: 'contended',
      },
      exitCode: 75,
    },
    {
      result: {
        kind: 'not-published',
        invocationId: INVOCATION_ID,
        cause: 'invalid-record',
        validation: { kind: 'malformed-json' },
      },
      exitCode: 70,
    },
    {
      result: {
        kind: 'not-published',
        invocationId: INVOCATION_ID,
        cause: 'coordination-unavailable',
      },
      exitCode: 75,
    },
    {
      result: {
        kind: 'undeterminable',
        invocationId: INVOCATION_ID,
        cause: 'io-failed',
        errcode: 5,
      },
      exitCode: 75,
    },
  ])('maps $result.kind to command exit $exitCode', async ({ result, exitCode }) => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const routingStatus: HandoffRoutingStatusCommandOperations = {
      resolve: async () => result,
      discard: async () => ({ kind: 'refused', status: { kind: 'absent' } }),
    };
    const program = new Command();
    program.exitOverride();
    registerBackendCommands(program, { routingStatus });

    await program.parseAsync([
      'node',
      'coral-cli',
      'backend',
      'routing-status',
      'resolve',
      '--invocation',
      INVOCATION_ID,
    ]);

    expect(process.exitCode).toBe(exitCode);
    expect(exitCode === 0 ? stdout : stderr).toHaveBeenCalledWith(`${formatHandoffRoutingResolveResult(result)}\n`);
  });

  it.each<readonly [HandoffRoutingResolveResult, string]>([
    [{ kind: 'stale', invocationId: INVOCATION_ID }, 'copy an invocation still shown as unresolved'],
    [{ kind: 'already-terminal', invocationId: INVOCATION_ID }, 'No resolution is needed'],
    [{ kind: 'live-owner', invocationId: INVOCATION_ID }, 'wait for the owner to finish'],
    [
      { kind: 'unauthorized-unobservable', invocationId: INVOCATION_ID, cause: 'incarnation-unavailable' },
      'verify the owner externally',
    ],
    [
      { kind: 'unauthorized-unobservable', invocationId: INVOCATION_ID, cause: 'probe-not-available' },
      'verify the owner externally',
    ],
    [
      { kind: 'unauthorized-unobservable', invocationId: INVOCATION_ID, cause: 'probe-failed' },
      'verify the owner externally',
    ],
    [
      { kind: 'unauthorized-unobservable', invocationId: INVOCATION_ID, cause: 'deadline-expired' },
      'cannot override an expired observation budget',
    ],
    [{ kind: 'status-unavailable', status: { kind: 'unreadable', reason: 'invalid-json' } }, 'discard command'],
    [{ kind: 'status-unavailable', status: { kind: 'unsupported-generation', generation: 2 } }, 'discard command'],
    [
      { kind: 'status-unavailable', status: { kind: 'undeterminable', cause: 'io-failed', errcode: 5 } },
      'without discarding',
    ],
    [
      {
        kind: 'not-published',
        invocationId: INVOCATION_ID,
        cause: 'contended',
      },
      `coral-cli backend routing-status resolve --invocation ${INVOCATION_ID}`,
    ],
    [
      {
        kind: 'not-published',
        invocationId: INVOCATION_ID,
        cause: 'generation-maintenance',
      },
      'maintenance lease has gone ten minutes without a heartbeat',
    ],
    [
      {
        kind: 'not-published',
        invocationId: INVOCATION_ID,
        cause: 'capacity-exhausted',
      },
      'storage-capacity condition',
    ],
    [
      {
        kind: 'not-published',
        invocationId: INVOCATION_ID,
        cause: 'io-failed',
      },
      'repair the reported storage condition',
    ],
    [
      {
        kind: 'not-published',
        invocationId: INVOCATION_ID,
        cause: 'unreadable',
      },
      'routing-status discard successor',
    ],
    [
      {
        kind: 'not-published',
        invocationId: INVOCATION_ID,
        cause: 'unsupported-generation',
      },
      'routing-status discard successor',
    ],
    [
      {
        kind: 'not-published',
        invocationId: INVOCATION_ID,
        cause: 'invalid-record',
        validation: { kind: 'envelope-body-disagreement' },
      },
      `journal is unaffected, and no storage action is appropriate. After installing corrected Coral software, rerun coral-cli backend routing-status resolve --invocation ${INVOCATION_ID}`,
    ],
    [
      {
        kind: 'not-published',
        invocationId: INVOCATION_ID,
        cause: 'rejected-transition',
      },
      'do not assume resolution occurred',
    ],
    [
      {
        kind: 'not-published',
        invocationId: INVOCATION_ID,
        cause: 'coordination-unavailable',
      },
      'make the generation coordination root writable again',
    ],
    [
      {
        kind: 'undeterminable',
        invocationId: INVOCATION_ID,
        cause: 'io-failed',
        errcode: 5,
      },
      'could not determine whether it committed',
    ],
    [
      {
        kind: 'undeterminable',
        invocationId: INVOCATION_ID,
        cause: 'contended',
        errcode: 5,
      },
      'contended commit completed',
    ],
    [
      {
        kind: 'undeterminable',
        invocationId: INVOCATION_ID,
        cause: 'capacity-exhausted',
        errcode: 13,
      },
      'storage-capacity condition',
    ],
    [
      {
        kind: 'undeterminable',
        invocationId: INVOCATION_ID,
        cause: 'unreadable',
        errcode: 26,
      },
      'if the journal is unreadable',
    ],
  ])('renders an outcome-specific successor for $0.kind', (result, expected) => {
    const rendered = formatHandoffRoutingResolveResult(result);
    expect(rendered).toContain(expected);
    if (result.kind === 'undeterminable') expect(rendered).not.toContain('was not published');
  });

  it('dispatches operator discard and reports its retained address', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const routingStatus: HandoffRoutingStatusCommandOperations = {
      resolve: async () => {
        throw new Error('not used');
      },
      discard: () => ({
        kind: 'discarded',
        artifactPath: `/state/run/handoff-routing.${HANDOFF_ROUTING_STATUS_GENERATION}.db`,
        quarantinePath: `/state/run/handoff-routing-quarantine/handoff-routing.${HANDOFF_ROUTING_STATUS_GENERATION}.db.event-id`,
        previousStatus: { kind: 'unreadable', reason: 'invalid-shape' },
      }),
    };
    const program = new Command();
    program.exitOverride();
    registerBackendCommands(program, { routingStatus });

    await program.parseAsync(['node', 'coral-cli', 'backend', 'routing-status', 'discard']);

    expect(stdout).toHaveBeenCalledWith(
      `Quarantined routing status from /state/run/handoff-routing.${HANDOFF_ROUTING_STATUS_GENERATION}.db at /state/run/handoff-routing-quarantine/handoff-routing.${HANDOFF_ROUTING_STATUS_GENERATION}.db.event-id.\n`,
    );
    expect(process.exitCode).toBe(0);
  });

  it.each([
    [{ kind: 'refused', status: { kind: 'absent' } } as const, 'Next step: no action is needed.', 0],
    [
      {
        kind: 'refused',
        status: {
          kind: 'current',
          generation: HANDOFF_ROUTING_STATUS_GENERATION,
          statuses: [],
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
        },
      } as const,
      'Next step: run coral-cli backend status and follow whatever successor it shows.',
      75,
    ],
    [
      { kind: 'refused', status: { kind: 'undeterminable', cause: 'io-failed', errcode: 5 } } as const,
      'Next step: retry coral-cli backend status without discarding',
      75,
    ],
    [
      { kind: 'coordinator-running', socketPath: '/state/run/coordinator.sock' } as const,
      'Next step: run coral-cli backend shutdown',
      75,
    ],
    [
      {
        kind: 'coordinator-socket-unobservable',
        socketPath: '/state/run/coordinator.sock',
        cause: 'bind-failed',
      } as const,
      'could not determine whether the coordinator socket is available',
      75,
    ],
    [
      { kind: 'coordinator-socket-insecure', socketPath: '/state/run/coordinator.sock' } as const,
      'repair the reported socket-directory ownership or permissions',
      75,
    ],
    [
      { kind: 'generation-maintenance-unavailable', cause: 'contended' } as const,
      'maintenance lease has gone ten minutes without a heartbeat',
      75,
    ],
    [
      {
        kind: 'generation-maintenance-unavailable',
        cause: 'writer-observation-unknown',
        holder: 'routing-status:handoff-routing-status (pid 42)',
      } as const,
      'retry after the lease has gone ten minutes without a heartbeat; do not delete the lease',
      75,
    ],
    [
      { kind: 'generation-maintenance-unavailable', cause: 'ownership-lost' } as const,
      'repair the generation coordination root, rerun coral-cli backend status, then retry',
      75,
    ],
    [
      { kind: 'incomplete-quarantine', quarantineId: '00000000-0000-4000-8000-000000000042' } as const,
      'routing-status quarantine clear --id 00000000-0000-4000-8000-000000000042',
      75,
    ],
    [
      { kind: 'quarantine-capacity-exhausted', maximum: 16 } as const,
      'routing-status quarantine list, clear exact entries',
      75,
    ],
    [
      {
        kind: 'quarantine-storage-failed',
        quarantineId: '00000000-0000-4000-8000-000000000042',
        quarantinePath: '/state/run/handoff-routing-quarantine/handoff-routing.db.00000000-0000-4000-8000-000000000042',
        movedArtifacts: ['wal'],
        cause: 'directory-sync-failed',
      } as const,
      'routing-status quarantine list, repair the reported storage condition, run coral-cli backend ' +
        'routing-status quarantine clear --id 00000000-0000-4000-8000-000000000042, then rerun ' +
        'coral-cli backend routing-status discard',
      75,
    ],
  ])('renders the discard refusal successor for case #%# with exit $2', async (result, expected, exitCode) => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const routingStatus: HandoffRoutingStatusCommandOperations = {
      resolve: async () => {
        throw new Error('not used');
      },
      discard: async () => result,
    };
    const program = new Command();
    program.exitOverride();
    registerBackendCommands(program, { routingStatus });

    await program.parseAsync(['node', 'coral-cli', 'backend', 'routing-status', 'discard']);

    expect(stderr).toHaveBeenCalledWith(expect.stringContaining(expected));
    expect(process.exitCode).toBe(exitCode);
  });

  it('lists complete and incomplete retained quarantines without hiding bounded overflow', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const routingStatusQuarantine: HandoffRoutingStatusQuarantineCommandOperations = {
      list: () => ({
        entries: [
          {
            id: INVOCATION_ID,
            quarantinePath: `/state/run/handoff-routing-quarantine/handoff-routing.${HANDOFF_ROUTING_STATUS_GENERATION}.db.${INVOCATION_ID}`,
            state: 'incomplete',
            artifacts: ['wal'],
          },
        ],
        overflow: true,
      }),
      clear: async () => {
        throw new Error('not used');
      },
    };
    const program = new Command();
    program.exitOverride();
    registerBackendCommands(program, { routingStatusQuarantine });

    await program.parseAsync(['node', 'coral-cli', 'backend', 'routing-status', 'quarantine', 'list']);

    expect(stdout).toHaveBeenCalledWith(expect.stringContaining(`id=${INVOCATION_ID} state=incomplete artifacts=wal`));
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining('did not reach every retained file'));
    expect(process.exitCode).toBe(75);
  });

  it('clears one exact retained quarantine by canonical ID', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const clear = vi.fn(async (quarantineId: string) => ({
      kind: 'cleared' as const,
      entry: {
        id: quarantineId,
        quarantinePath: `/state/run/handoff-routing-quarantine/handoff-routing.${HANDOFF_ROUTING_STATUS_GENERATION}.db.${quarantineId}`,
        state: 'complete' as const,
        artifacts: ['database' as const],
      },
    }));
    const routingStatusQuarantine: HandoffRoutingStatusQuarantineCommandOperations = {
      list: () => ({ entries: [], overflow: false }),
      clear,
    };
    const program = new Command();
    program.exitOverride();
    registerBackendCommands(program, { routingStatusQuarantine });

    await program.parseAsync([
      'node',
      'coral-cli',
      'backend',
      'routing-status',
      'quarantine',
      'clear',
      '--id',
      INVOCATION_ID,
    ]);

    expect(clear).toHaveBeenCalledWith(INVOCATION_ID);
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining(`Cleared routing-status quarantine ${INVOCATION_ID}`));
    expect(process.exitCode).toBe(0);
  });

  it('renders the exact list and retry successor after a partial quarantine clear', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const routingStatusQuarantine: HandoffRoutingStatusQuarantineCommandOperations = {
      list: () => ({ entries: [], overflow: false }),
      clear: async (quarantineId) => ({
        kind: 'quarantine-clear-storage-failed',
        quarantineId,
        quarantinePath: `/state/run/handoff-routing-quarantine/handoff-routing.db.${quarantineId}`,
        removedArtifacts: ['wal'],
        cause: 'directory-sync-failed',
      }),
    };
    const program = new Command();
    program.exitOverride();
    registerBackendCommands(program, { routingStatusQuarantine });

    await program.parseAsync([
      'node',
      'coral-cli',
      'backend',
      'routing-status',
      'quarantine',
      'clear',
      '--id',
      INVOCATION_ID,
    ]);

    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('coral-cli backend routing-status quarantine list'));
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining(`coral-cli backend routing-status quarantine clear --id ${INVOCATION_ID}`),
    );
    expect(process.exitCode).toBe(75);
  });
});
