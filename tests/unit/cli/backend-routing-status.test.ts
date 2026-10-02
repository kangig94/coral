import { Command } from 'commander';
import { afterEach, expect, it, vi } from 'vitest';
import {
  registerBackendCommands,
  type HandoffRoutingStatusCommandOperations,
  type HandoffRoutingStatusQuarantineCommandOperations,
} from '#src/cli/commands/backend.js';

const INVOCATION_ID = '123e4567-e89b-42d3-a456-426614174000';

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

it('keeps an expired owner observation refused even with force', async () => {
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const resolve = vi.fn<HandoffRoutingStatusCommandOperations['resolve']>(async (request) => ({
    kind: 'unauthorized-unobservable',
    invocationId: request.invocationId,
    cause: 'deadline-expired',
  }));
  const program = new Command().exitOverride();
  registerBackendCommands(program, {
    routingStatus: { resolve, discard: () => ({ kind: 'refused', status: { kind: 'absent' } }) },
  });

  await program.parseAsync([
    'node',
    'coral-cli',
    'backend',
    'routing-status',
    'resolve',
    '--invocation',
    INVOCATION_ID,
    '--force-unobservable',
  ]);

  expect(resolve).toHaveBeenCalledWith({
    kind: 'routing-status-resolve',
    invocationId: INVOCATION_ID,
    forceUnobservable: true,
  });
  expect(stdout).not.toHaveBeenCalled();
  expect(stderr).toHaveBeenCalledWith(expect.stringContaining('cannot override'));
  expect(process.exitCode).toBe(75);
});

it('does not report an unreadable quarantine artifact as absent', async () => {
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const routingStatusQuarantine: HandoffRoutingStatusQuarantineCommandOperations = {
    list: () => ({ kind: 'listed', entries: [], overflow: false }),
    clear: async (quarantineId) => ({
      kind: 'quarantine-clear-undeterminable',
      quarantineId,
      quarantinePath: `/state/run/handoff-routing-quarantine/${quarantineId}`,
      artifact: 'database',
      errcode: 13,
    }),
  };
  const program = new Command().exitOverride();
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

  expect(stdout).not.toHaveBeenCalled();
  expect(stderr).toHaveBeenCalledWith(expect.stringContaining(`quarantine clear --id ${INVOCATION_ID}`));
  expect(process.exitCode).toBe(75);
});

it('retains the list and retry actions after a partial clear', async () => {
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const routingStatusQuarantine: HandoffRoutingStatusQuarantineCommandOperations = {
    list: () => ({ kind: 'listed', entries: [], overflow: false }),
    clear: async (quarantineId) => ({
      kind: 'quarantine-clear-storage-failed',
      quarantineId,
      quarantinePath: `/state/run/handoff-routing-quarantine/${quarantineId}`,
      removedArtifacts: [],
      observedRemovedArtifacts: ['wal'],
      syncedDirectories: [],
      cause: 'directory-sync-failed',
    }),
  };
  const program = new Command().exitOverride();
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
  expect(stderr).toHaveBeenCalledWith(expect.stringContaining(`quarantine clear --id ${INVOCATION_ID}`));
  expect(process.exitCode).toBe(75);
});
