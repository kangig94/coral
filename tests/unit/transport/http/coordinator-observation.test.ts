// The evidence `backend status` and `backend shutdown` share.
//
// They ask the same three questions about the local coordinator — can the record be read, was one written, is
// the recorded process still there — and answered them separately, which gave one subject two vocabularies:
// `undecodable_record` on one side and `unreadable_record` on the other, for the same two lines reading the
// same file, with `reason` typed on one and free-form on the other. Each was then corrected once without the
// other, in both directions. This file holds the shared answer so that cannot recur silently.

import { describe, expect, it, vi } from 'vitest';

import type * as BackendDiscoveryModule from '#src/infra/backend-discovery.js';
import type * as NodeProcessModule from '#src/infra/node-process.js';
import type { CoordinatorDiscoveryRecord, DiscoveryRead } from '#src/infra/backend-discovery.js';

const mockState = vi.hoisted(() => ({
  read: { kind: 'missing' } as DiscoveryRead,
  liveness: 'alive' as 'alive' | 'absent' | 'unknown',
}));

vi.mock('#src/infra/backend-discovery.js', async (importOriginal) => {
  const actual = await importOriginal<typeof BackendDiscoveryModule>();
  return { ...actual, readDiscoveryRecordDisposition: vi.fn(() => mockState.read) };
});

vi.mock('#src/infra/node-process.js', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeProcessModule>();
  return { ...actual, observeProcessLiveness: vi.fn(() => mockState.liveness) };
});

import { observeCoordinator } from '#src/transport/http/backend/coordinator-observation.js';

const INFO_FILE = '/run/coral/coordinator.json';

function runtime() {
  return {
    storage: {},
    env: {},
    paths: { coral: { coordinator: { infoFile: INFO_FILE } } },
  } as unknown as Parameters<typeof observeCoordinator>[0];
}

function record(overrides: Partial<CoordinatorDiscoveryRecord> = {}): CoordinatorDiscoveryRecord {
  return {
    pid: 4242,
    port: 4321,
    socketPath: '/tmp/coral.sock',
    bundleHash: 'hash',
    flavor: 'prod',
    namespace: 'ns',
    startedAt: 1,
    token: 'token',
    bootToken: 'boot-token',
    ...overrides,
  };
}

describe('observeCoordinator', () => {
  it.each([['corrupt-json'], ['shape-rejected']] as const)(
    'reports a %s record as unreadable, carrying the path its remedy needs',
    (reason) => {
      mockState.read = { kind: 'undecodable', reason };

      expect(observeCoordinator(runtime())).toEqual({ kind: 'unreadable-record', reason, path: INFO_FILE });
    },
  );

  it('reports a missing record as an absence', () => {
    mockState.read = { kind: 'missing' };

    expect(observeCoordinator(runtime())).toEqual({ kind: 'no-record' });
  });

  it('reports a decisively gone process as an absence, and names the pid', () => {
    mockState.read = { kind: 'record', record: record() };
    mockState.liveness = 'absent';

    expect(observeCoordinator(runtime())).toEqual({ kind: 'process-absent', pid: 4242 });
    mockState.liveness = 'alive';
  });

  it('keeps the record when the pid could not be observed, because unknown is not absent', () => {
    mockState.read = { kind: 'record', record: record() };
    mockState.liveness = 'unknown';

    expect(observeCoordinator(runtime())).toMatchObject({ kind: 'addressed' });
    mockState.liveness = 'alive';
  });

  it('defaults the host so neither command re-derives it', () => {
    mockState.read = { kind: 'record', record: record({ host: undefined }) };

    expect(observeCoordinator(runtime())).toMatchObject({
      kind: 'addressed',
      coordinator: { host: '127.0.0.1' },
    });
  });

  it('addresses a record that omits version and instanceId, which neither command reads', () => {
    // `readBackendInfo` answers `null` for exactly this record, and routing through it is what reported a
    // serving cross-version coordinator as not running in both commands.
    mockState.read = { kind: 'record', record: record() };

    expect(observeCoordinator(runtime())).toMatchObject({ kind: 'addressed', coordinator: { pid: 4242 } });
  });
});
