// The evidence `backend status` and `backend shutdown` share.
//
// They ask the same three questions about the local coordinator — can the record be read, was one written, is
// the recorded process still there — and answered them separately, which gave one subject two vocabularies:
// `undecodable_record` on one side and `unreadable_record` on the other, for the same two lines reading the
// same file, with `reason` typed on one and free-form on the other. Each was then corrected once without the
// other, in both directions. This file holds the shared answer so that cannot recur silently.

import { beforeEach, describe, expect, it, vi } from 'vitest';

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
const SOCKET_PATH = '/run/coral/coordinator.sock';

function runtime(socketExists = false) {
  return {
    storage: { existsSync: (path: string) => socketExists && path === SOCKET_PATH },
    env: {},
    paths: { coral: { coordinator: { infoFile: INFO_FILE, socketPath: SOCKET_PATH } } },
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
  // Reset here rather than at the tail of each test that mutates it. Three tests below set `liveness` and two
  // restored it on their last line — a restore an assertion that throws skips, leaking `'absent'` into
  // whatever ran next and turning one failure into a cascade that names the wrong test. The same reasoning
  // already put an `afterEach` in `tests/unit/transport/http/backend-status.test.ts`.
  beforeEach(() => {
    mockState.read = { kind: 'missing' };
    mockState.liveness = 'alive';
  });

  it.each([['corrupt-json'], ['shape-rejected']] as const)(
    'reports a %s record as unreadable, carrying the path its remedy needs',
    (reason) => {
      mockState.read = { kind: 'undecodable', reason };

      expect(observeCoordinator(runtime())).toEqual({ kind: 'unreadable-record', reason, path: INFO_FILE });
    },
  );

  it('reports a missing record with no socket as an absence', () => {
    mockState.read = { kind: 'missing' };

    expect(observeCoordinator(runtime())).toEqual({ kind: 'no-record' });
  });

  // A coordinator binds its socket before it writes its record, so a missing record alone does not place one
  // absent. The socket is the earlier evidence, and holding it is what the two absences below do not need: it
  // is the only thing separating "nothing started" from "something started and has not recorded itself yet".
  it('refuses to call a missing record an absence while the socket is still there', () => {
    mockState.read = { kind: 'missing' };

    expect(observeCoordinator(runtime(true))).toEqual({
      kind: 'no-record-socket-present',
      socketPath: SOCKET_PATH,
    });
  });

  // Both halves of the dead coordinator's identity, because `status` scopes a startup diagnostic by both: a
  // pid is reused, so a pid alone admits an older run's diagnostic as this one's explanation. Dropping
  // `startedAt` from this variant re-opened that while the comment at the call site still claimed it was shut.
  it('reports a decisively gone process as an absence, naming the pid and when it started', () => {
    mockState.read = { kind: 'record', record: record({ pid: 4242, startedAt: 1_700_000_000_000 }) };
    mockState.liveness = 'absent';

    expect(observeCoordinator(runtime())).toEqual({
      kind: 'process-absent',
      pid: 4242,
      startedAt: 1_700_000_000_000,
    });
  });

  it('keeps the record when the pid could not be observed, because unknown is not absent', () => {
    mockState.read = { kind: 'record', record: record() };
    mockState.liveness = 'unknown';

    expect(observeCoordinator(runtime())).toMatchObject({ kind: 'addressed' });
  });

  it('defaults the host so neither command re-derives it', () => {
    mockState.read = { kind: 'record', record: record({ host: undefined }) };

    expect(observeCoordinator(runtime())).toMatchObject({
      kind: 'addressed',
      coordinator: { host: '127.0.0.1' },
    });
  });

  // Only the default side of `record.host ?? DEFAULT_DISCOVERY_HOST` had a test; a record that actually
  // carries a host would fall back to the default just the same if the `??` were ever flipped to `||` or the
  // branches swapped, and nothing here would have caught it.
  it('keeps a recorded host instead of defaulting it', () => {
    mockState.read = { kind: 'record', record: record({ host: '10.0.0.5' }) };

    expect(observeCoordinator(runtime())).toMatchObject({
      kind: 'addressed',
      coordinator: { host: '10.0.0.5' },
    });
  });

  // `pidLiveness` is the one fact `shutdown`'s `capability_rejected` refusal needs to avoid promising a 401
  // confirmed a pid it never observed — carried straight through from the liveness check just above it.
  it('carries alive liveness through into the addressed observation', () => {
    mockState.read = { kind: 'record', record: record() };
    mockState.liveness = 'alive';

    expect(observeCoordinator(runtime())).toMatchObject({ kind: 'addressed', pidLiveness: 'alive' });
  });

  it('carries unknown liveness through into the addressed observation, rather than upgrading it', () => {
    mockState.read = { kind: 'record', record: record() };
    mockState.liveness = 'unknown';

    expect(observeCoordinator(runtime())).toMatchObject({ kind: 'addressed', pidLiveness: 'unknown' });
  });

  it('addresses a record that omits version and instanceId, which neither command reads', () => {
    // `readBackendInfo` answers `null` for exactly this record, and routing through it is what reported a
    // serving cross-version coordinator as not running in both commands.
    mockState.read = { kind: 'record', record: record() };

    expect(observeCoordinator(runtime())).toMatchObject({ kind: 'addressed', coordinator: { pid: 4242 } });
  });
});
