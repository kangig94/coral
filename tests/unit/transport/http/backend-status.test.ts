// A missing record, an absent recorded process, and a decoded foreign identity are distinct observations;
// none may be widened into a claim that no coordinator exists.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BackendInfo } from '#src/infra/backend-discovery.js';
import type { BackendStatusFull, ShutdownRemainderReport } from '#src/transport/http/backend/status.js';
import type { StrictBundleIdentityResult } from '#src/infra/bundle-manifest.js';
import type { CoordinatorObservation } from '#src/transport/http/backend/coordinator-observation.js';
import { reserveRefusedPort } from '../../../fixtures/refused-port.js';
import { encodeProviderProxySetAddress } from '#src/provider-proxy/set-address.js';

const NOW = 1_700_000_000_000;

const SELF_BUNDLE_HASH = '0123456789abcdef';
const SELF_NAMESPACE = 'self-namespace';

const mockState = vi.hoisted(() => ({
  observed: { kind: 'no-record' } as CoordinatorObservation,
  /** The startup diagnostic on disk, or `null` for none. */
  diagnostic: null as string | null,
  remainderFiles: [] as Array<{
    name: string;
    value: string;
    mtimeMs: number;
    statErrorCode?: string;
    readErrorCode?: string;
    unlinkErrorCode?: string;
  }>,
  remainderScanErrorCode: null as string | null,
  cleanupRefusalState: null as string | null,
  /** Whether this build can prove its own bundle identity; `false` makes every record's authorship unprovable. */
  strictIdentityProven: true,
  stageLiveness: 'unknown' as 'alive' | 'absent' | 'unknown',
}));

// Mocked at the seam this function depends on. `status` and `shutdown` ask the same three questions about the
// coordinator, and driving them through two lower mocks meant each test file re-assembled that prelude itself
// — two fixtures for one observation, which is the duplication the production split removed.
vi.mock('#src/transport/http/backend/coordinator-observation.js', () => ({
  observeCoordinator: vi.fn(() => mockState.observed),
}));

vi.mock('#src/infra/bundle-manifest.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    readBuildFlavor: vi.fn(() => 'prod'),
    resolveStrictBundleIdentity: vi.fn(
      (): StrictBundleIdentityResult =>
        mockState.strictIdentityProven
          ? {
              ok: true,
              manifest: {
                version: '0.5.2',
                buildSetId: '00000000-0000-4000-8000-000000000000',
                flavor: 'prod',
                storeFormatFingerprint: `sha256:${'0'.repeat(64)}`,
                bundleHash: '0123456789abcdef',
                cliBundleHash: '0123456789abcdef',
                claudeAppserverBundleHash: '0123456789abcdef',
                durableWrapperBundleHash: '0123456789abcdef',
              },
            }
          : { ok: false, reason: 'embedded_identity_unavailable' },
    ),
  };
});

vi.mock('#src/infra/plugin-identity.js', () => ({
  pluginRootNamespace: vi.fn(() => 'self-namespace'),
}));

vi.mock('#src/runtime/real.js', () => ({
  createRealRuntime: vi.fn(() => ({
    storage: {
      existsSync: (path: string) => path === '/run/coral/shutdown-remainder.v1' && mockState.remainderFiles.length > 0,
      readdirSync: (path: string) => {
        if (mockState.remainderScanErrorCode !== null) {
          throw Object.assign(new Error('remainder directory unreadable'), {
            code: mockState.remainderScanErrorCode,
          });
        }
        const root = '/run/coral/shutdown-remainder.v1';
        const prefix = path === root ? '' : `${path.slice(root.length + 1)}/`;
        const entries = [
          ...new Set(
            mockState.remainderFiles
              .filter(({ name }) => name.startsWith(prefix))
              .map(({ name }) => name.slice(prefix.length).split('/')[0])
              .filter((name): name is string => name !== undefined && name.length > 0),
          ),
        ];
        if (entries.length === 0) throw Object.assign(new Error('no remainder directory'), { code: 'ENOENT' });
        return entries;
      },
      statSync: (path: string) => {
        const name = path.slice('/run/coral/shutdown-remainder.v1/'.length);
        const file = mockState.remainderFiles.find((candidate) => candidate.name === name);
        if (file === undefined) {
          throw Object.assign(new Error('no remainder metadata'), { code: 'ENOENT' });
        }
        if (file.statErrorCode !== undefined) {
          throw Object.assign(new Error('remainder metadata unavailable'), { code: file.statErrorCode });
        }
        return { mtimeMs: file.mtimeMs };
      },
      readFileSync: (path: string) => {
        if (path === '/tmp/coral-startup.json') {
          if (mockState.diagnostic === null) throw Object.assign(new Error('no diagnostic'), { code: 'ENOENT' });
          return mockState.diagnostic;
        }
        if (path === '/run/coral/shutdown-remainder-cleanup-refusals.v1.json') {
          if (mockState.cleanupRefusalState === null) {
            throw Object.assign(new Error('no cleanup refusal state'), { code: 'ENOENT' });
          }
          return mockState.cleanupRefusalState;
        }
        const name = path.slice('/run/coral/shutdown-remainder.v1/'.length);
        const file = mockState.remainderFiles.find((candidate) => candidate.name === name);
        if (file === undefined) throw Object.assign(new Error('no remainder'), { code: 'ENOENT' });
        if (file.readErrorCode !== undefined) {
          throw Object.assign(new Error('remainder content unavailable'), { code: file.readErrorCode });
        }
        return file.value;
      },
      renameSync: () => {
        throw new Error('remainder rename was not expected');
      },
      unlinkSync: (path: string) => {
        const name = path.slice('/run/coral/shutdown-remainder.v1/'.length);
        const index = mockState.remainderFiles.findIndex((candidate) => candidate.name === name);
        const file = mockState.remainderFiles[index];
        if (file === undefined) throw Object.assign(new Error('no remainder'), { code: 'ENOENT' });
        if (file.unlinkErrorCode !== undefined) {
          throw Object.assign(new Error('remainder deletion unavailable'), { code: file.unlinkErrorCode });
        }
        mockState.remainderFiles.splice(index, 1);
      },
      writeAtomicDurableSync: (path: string, data: string | NodeJS.ArrayBufferView) => {
        if (path !== '/run/coral/shutdown-remainder-cleanup-refusals.v1.json') return false;
        mockState.cleanupRefusalState =
          typeof data === 'string'
            ? data
            : Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf-8');
        return true;
      },
    },
    env: { platform: () => 'linux' },
    process: {
      observeLiveness: () => mockState.stageLiveness,
      readProcessIncarnation: () => null,
    },
    time: { now: () => 1_700_000_000_000 },
    paths: {
      coral: {
        coordinator: {
          runDir: '/run/coral',
          startupDiagnosticFile: '/tmp/coral-startup.json',
          infoFile: '/run/coral/coordinator.json',
        },
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
    mockState.remainderFiles = [];
    mockState.remainderScanErrorCode = null;
    mockState.cleanupRefusalState = null;
    mockState.strictIdentityProven = true;
    mockState.stageLiveness = 'unknown';
  });

  // `vi.stubGlobal` replaces a process-wide binding, so cleanup cannot live at the tail of each test: an
  // assertion that throws skips it, and a test that stubs without a tail call leaks its `fetch` into whatever
  // runs next.
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reports no_record_no_socket when neither discovery evidence nor a socket exists', async () => {
    const { getBackendStatusFull } = await import('#src/transport/http/backend/status.js');

    await expect(getBackendStatusFull('/plugin-root')).resolves.toEqual({ status: 'no_record_no_socket' });
  });

  // 'undecodable' is decisive about the content (it was read, and it is provably not a usable record), and an
  // 'unreadable' one is a genuine unknown about content but never about the fact that a byte was refused
  // (design-philosophy.md principle 11). Neither proves anything about *when* the file was written, so an
  // unknown or stale age excludes neither from the report — the prune this build performs at the next
  // coordinator startup (`pruneShutdownRemainderRecords`) is the only thing that ever silently ends an
  // undecodable record's visibility, and this report must not race ahead of that by excluding it first.
  it.each(['EIO', 'EACCES'])('reports an undecodable record whose age is also unknown (%s)', async (code) => {
    mockState.remainderFiles = [remainderFile('corrupt.json', NOW - 10_000, '{not-json', code)];

    const { getBackendStatusFull } = await import('#src/transport/http/backend/status.js');

    await expect(getBackendStatusFull('/plugin-root')).resolves.toEqual({
      status: 'no_record_no_socket',
      shutdownRemainder: {
        status: 'shutdown_remainder_unreadable',
        reason: 'records-skipped',
        skippedUnreadableRecordNames: [],
        skippedCorruptRecordCount: 1,
        skippedUnsupportedRecordCount: 0,
      },
    });
  });

  // The correlated, realistic case: the read is refused independently of the stat, so no byte of the content
  // is ever seen. This is a genuine unknown and must be reported rather than silenced (design-philosophy.md
  // principle 11), named by the one piece of evidence an operator-less reader has for it: its filename.
  it('reports a record whose stat and read were both refused, named by filename', async () => {
    mockState.remainderFiles = [remainderFile('unreadable.json', NOW - 10_000, '{not-json', 'EIO', 'EIO')];

    const { getBackendStatusFull } = await import('#src/transport/http/backend/status.js');

    await expect(getBackendStatusFull('/plugin-root')).resolves.toEqual({
      status: 'no_record_no_socket',
      shutdownRemainder: {
        status: 'shutdown_remainder_unreadable',
        reason: 'records-skipped',
        skippedUnreadableRecordNames: ['unreadable.json'],
        skippedCorruptRecordCount: 0,
        skippedUnsupportedRecordCount: 0,
        quarantined: [{ subject: 'unreadable.json', retry: { trigger: 'coordinator-startup' } }],
      },
    });
  });

  it('reports a writer-unobservable staging publication instead of treating the directory as empty', async () => {
    mockState.remainderFiles = [remainderFile('staged.json.stage.4242.unobserved.tmp', NOW - 10_000, '{partial')];

    const { getBackendStatusFull } = await import('#src/transport/http/backend/status.js');

    const result = await getBackendStatusFull('/plugin-root');

    expect(result).toEqual({
      status: 'no_record_no_socket',
      shutdownRemainder: {
        status: 'shutdown_remainder_unreadable',
        reason: 'records-skipped',
        skippedUnreadableRecordNames: [],
        skippedCorruptRecordCount: 0,
        skippedUnsupportedRecordCount: 0,
        staging: { writerAliveCount: 0, writerUnobservableCount: 1, orphanedCount: 0 },
        quarantined: [{ subject: 'staged.json.stage.4242.unobserved.tmp', retry: { trigger: 'coordinator-startup' } }],
      },
    });
    const { formatBackendStatus } = await import('#src/cli/format/backend.js');
    const output = formatBackendStatus(result, { kind: 'absent' }, null);

    expect(output).toContain('Shutdown remainder publication stages with unobservable writers: 1');
    expect(output).toContain(
      '  Disposition: writer state is unknown; an unresolved stage remains at its original path as quarantined, is excluded from periodic maintenance, and is retried only at the next coordinator startup.',
    );
    expect(output).not.toContain('  Recheck:');
    expect(output).not.toContain('publications in progress');
    expect(output).not.toContain('background discovery intervals');
  });

  it('reports an unrecognized predecessor directory as present and outside cleanup ownership', async () => {
    mockState.remainderFiles = [remainderFile('quarantine/evidence', NOW - 10_000, '{}')];

    const { getBackendStatusFull } = await import('#src/transport/http/backend/status.js');

    await expect(getBackendStatusFull('/plugin-root')).resolves.toEqual({
      status: 'no_record_no_socket',
      shutdownRemainder: {
        status: 'shutdown_remainder_unowned',
        unrecognizedEntryNames: ['quarantine'],
      },
    });
  });

  it('reports a quarantined subject by its original identity and startup retry disposition', async () => {
    mockState.remainderFiles = [remainderFile('locked.json', NOW - 10_000, '{}', undefined, 'EACCES')];

    const { getBackendStatusFull } = await import('#src/transport/http/backend/status.js');

    await expect(getBackendStatusFull('/plugin-root')).resolves.toEqual({
      status: 'no_record_no_socket',
      shutdownRemainder: {
        status: 'shutdown_remainder_unreadable',
        reason: 'records-skipped',
        skippedUnreadableRecordNames: ['locked.json'],
        skippedCorruptRecordCount: 0,
        skippedUnsupportedRecordCount: 0,
        quarantined: [
          {
            subject: 'locked.json',
            retry: { trigger: 'coordinator-startup' },
          },
        ],
      },
    });
  });

  it('reports the single stage left unscanned by a 129-entry stage scan', async () => {
    mockState.remainderFiles = Array.from({ length: 129 }, (_, index) =>
      remainderFile(`staged-${index}.json.stage.4242.unobserved.tmp`, NOW - index, '{partial', 'ENOENT'),
    );

    const { getBackendStatusFull } = await import('#src/transport/http/backend/status.js');

    await expect(getBackendStatusFull('/plugin-root')).resolves.toEqual({
      status: 'no_record_no_socket',
      shutdownRemainder: {
        status: 'shutdown_remainder_unreadable',
        reason: 'records-skipped',
        skippedUnreadableRecordNames: [],
        skippedCorruptRecordCount: 0,
        skippedUnsupportedRecordCount: 0,
        unscannedStageCount: 1,
      },
    });
  });

  // Same disposition with a known, stale mtime: neither reason is filtered by age.
  it('reports an unreadable record from outside the recent-record window', async () => {
    mockState.remainderFiles = [remainderFile('ancient.json', NOW - 300_001, 'irrelevant', undefined, 'EACCES')];

    const { getBackendStatusFull } = await import('#src/transport/http/backend/status.js');

    await expect(getBackendStatusFull('/plugin-root')).resolves.toEqual({
      status: 'no_record_no_socket',
      shutdownRemainder: {
        status: 'shutdown_remainder_unreadable',
        reason: 'records-skipped',
        skippedUnreadableRecordNames: ['ancient.json'],
        skippedCorruptRecordCount: 0,
        skippedUnsupportedRecordCount: 0,
        quarantined: [{ subject: 'ancient.json', retry: { trigger: 'coordinator-startup' } }],
      },
    });
  });

  it('does not report a directory entry confirmed gone during the read race', async () => {
    mockState.remainderFiles = [remainderFile('vanished.json', NOW - 10_000, '{not-json', undefined, 'ENOENT')];

    const { getBackendStatusFull } = await import('#src/transport/http/backend/status.js');

    await expect(getBackendStatusFull('/plugin-root')).resolves.toEqual({ status: 'no_record_no_socket' });
  });

  it('lets a fresh diagnostic supersede the no-record fallback', async () => {
    mockState.diagnostic = startupDiagnostic(NOW - 10_000, 4242);

    const { getBackendStatusFull } = await import('#src/transport/http/backend/status.js');

    await expect(getBackendStatusFull('/plugin-root')).resolves.toMatchObject({
      status: 'recent_failure',
      phase: 'startup_failed',
    });
  });

  // The sequel a shutdown remainder exists for: instance A drains leaving obligations undischarged, instance B
  // boots and fails before ever writing its own discovery record, so `observed.kind` is `no-record` and
  // `coordinator` is `undefined` here — the one path where the remainder scope is directory-wide and a genuine
  // predecessor's record (a different instance id than anything else in this fixture) is reachable at all.
  it("attaches a predecessor instance's directory-scoped remainder to an unscoped startup diagnostic", async () => {
    mockState.diagnostic = startupDiagnostic(NOW - 10_000, 4242);
    mockState.remainderFiles = [
      remainderFile('predecessor-instance.json', NOW - 20_000, shutdownRemainder('predecessor-instance', NOW - 20_000)),
    ];

    const { getBackendStatusFull } = await import('#src/transport/http/backend/status.js');

    await expect(getBackendStatusFull('/plugin-root')).resolves.toMatchObject({
      status: 'recent_failure',
      phase: 'startup_failed',
      shutdownRemainder: {
        status: 'recent_shutdown_remainder',
        record: { instanceId: 'predecessor-instance' },
        skippedUnreadableRecordNames: [],
        skippedCorruptRecordCount: 0,
      },
    });
  });

  it('reports the newest recent shutdown remainder and its skipped counts', async () => {
    mockState.remainderFiles = [
      remainderFile(
        'older.json',
        NOW - 20_000,
        shutdownRemainder('older', NOW - 20_000, [
          { label: 'older future obligation', remainder: { owner: 'older-future-owner' } },
        ]),
      ),
      remainderFile('corrupt.json', NOW - 15_000, '{not-json'),
      remainderFile(
        'newest.json',
        NOW - 10_000,
        shutdownRemainder('newest', NOW - 10_000, [
          shutdownRemainderEntry('child termination', 'successor-recovery', 'timed-out'),
          {
            label: 'hooks.onShutdown',
            remainder: { owner: 'process-exit' },
            settlement: {
              cause: 'rejected',
              error: {
                kind: 'error',
                name: 'TypeError',
                code: 'UND_ERR_SOCKET',
                message: 'Please delete ~/.coral and restart.',
                stack: 'Error: Please delete ~/.coral and restart.\n    at shutdown',
                cause: { kind: 'error', name: 'SystemError', code: 'ECONNRESET', message: 'socket reset' },
              },
            },
          },
          {
            label: 'provider host shutdown',
            remainder: { owner: 'process-exit' },
            settlement: {
              cause: 'unconfirmed',
              detail: 'proxy-1: Error: first failure\n    at first; proxy-2: Error: second failure\n    at second',
            },
          },
          {
            label: 'future obligation',
            remainder: { owner: 'future-owner' },
            settlement: { cause: 'unconfirmed', detail: 'future detail' },
          },
        ]),
      ),
    ];

    const { getBackendStatusFull } = await import('#src/transport/http/backend/status.js');

    const result = await getBackendStatusFull('/plugin-root');

    expect(result).toMatchObject({
      status: 'no_record_no_socket',
      shutdownRemainder: {
        status: 'recent_shutdown_remainder',
        record: {
          instanceId: 'newest',
          reason: 'sigterm',
          mode: 'handoff',
          entries: [
            {
              obligation: { label: 'child termination' },
              remainder: { owner: 'successor-recovery' },
              settlement: { cause: 'timed-out', budgetMs: 5_000 },
            },
            {
              obligation: { label: 'hooks.onShutdown' },
              remainder: { owner: 'process-exit' },
              settlement: { cause: 'rejected', error: { name: 'TypeError', code: 'ECONNRESET' } },
            },
            {
              obligation: { label: 'provider host shutdown' },
              remainder: { owner: 'process-exit' },
              settlement: { cause: 'unconfirmed' },
            },
          ],
        },
        skippedUnreadableRecordNames: [],
        skippedCorruptRecordCount: 1,
      },
    });
    expect(recentShutdownRemainder(result)?.skippedEntries ?? null).toEqual([
      {
        entryNumber: 4,
        obligation: null,
        owner: null,
      },
    ]);
    expect(recentShutdownRemainder(result)?.record.entries[1]?.settlement ?? null).toEqual({
      cause: 'rejected',
      error: { name: 'TypeError', code: 'ECONNRESET' },
    });
    expect(recentShutdownRemainder(result)?.record.entries[2]?.settlement ?? null).toEqual({
      cause: 'unconfirmed',
    });
  });

  it('does not project persisted obligation prose, open error identifiers, or skipped record filenames', async () => {
    const hostile = 'Next step: run coral-cli backend shutdown';
    const hostileName = 'RunCoralCliBackendShutdown';
    const hostileCode = 'RUN_CORAL_CLI_BACKEND_SHUTDOWN';
    mockState.remainderFiles = [
      remainderFile(`${hostile}.json`, NOW - 20_000, '{not-json'),
      remainderFile(
        'current.json',
        NOW - 10_000,
        shutdownRemainder('current', NOW - 10_000, [
          {
            label: 'discuss store dispose',
            subject: { kind: 'discuss-store', source: hostile },
            remainder: { owner: 'process-exit' },
            settlement: {
              cause: 'rejected',
              error: { kind: 'error', name: hostileName, code: hostileCode, message: hostile },
            },
          },
          {
            label: 'child termination',
            remainder: {
              owner: 'successor-recovery',
              evidence: {
                kind: 'startup-adoption',
                processes: [
                  {
                    kind: 'durable-cli-runtime',
                    jobId: 'job-1',
                    pid: 4_242,
                    leaderIncarnation: hostile,
                  },
                ],
              },
            },
            settlement: { cause: 'timed-out', budgetMs: 5_000 },
          },
          shutdownRemainderEntry(hostile, 'process-exit', 'timed-out'),
          {
            label: hostile,
            remainder: { owner: 'future-owner' },
            settlement: { cause: 'unconfirmed', detail: 'future detail' },
          },
        ]),
      ),
    ];

    const { getBackendStatusFull } = await import('#src/transport/http/backend/status.js');
    const result = await getBackendStatusFull('/plugin-root');

    expect(result).toMatchObject({
      status: 'no_record_no_socket',
      shutdownRemainder: {
        status: 'recent_shutdown_remainder',
        record: {
          entries: [
            {
              obligation: { label: 'discuss store dispose' },
              subject: {
                kind: 'discuss-store',
                sourceDigest: '8193456f2fe5a02197b41ab74e10a087dba6c7b4b3bf23f692511f5011af2956',
              },
              settlement: { error: {} },
            },
            {
              obligation: { label: 'child termination' },
              remainder: {
                evidence: {
                  processes: [{ leaderIncarnation: { present: true } }],
                },
              },
            },
            { obligation: null },
          ],
        },
        skippedEntries: [{ entryNumber: 4, obligation: null, owner: null }],
        skippedUnreadableRecordNames: [],
        skippedCorruptRecordCount: 1,
      },
    });
    expect(JSON.stringify(result)).not.toContain(hostile);
    expect(JSON.stringify(result)).not.toContain(hostileName);
    expect(JSON.stringify(result)).not.toContain(hostileCode);
  });

  it('projects exactly the declared shutdown remainder key paths, closing any field a spread could add unseen', async () => {
    mockState.remainderFiles = [
      remainderFile('corrupt.json', NOW - 15_000, '{not-json'),
      remainderFile('locked.json', NOW - 12_000, 'irrelevant', undefined, 'EIO'),
      remainderFile(
        'current.json',
        NOW - 10_000,
        shutdownRemainder('current', NOW - 10_000, [
          {
            label: 'discuss store dispose',
            subject: { kind: 'discuss-store', source: 'owner/repo' },
            remainder: { owner: 'process-exit' },
            settlement: {
              cause: 'rejected',
              error: { kind: 'error', name: 'Error', code: 'EIO', message: 'x' },
            },
          },
          {
            label: 'stream response close 7',
            remainder: {
              owner: 'successor-recovery',
              evidence: {
                kind: 'startup-adoption',
                processes: [{ kind: 'durable-cli-runtime', jobId: 'job-x', pid: 99, leaderIncarnation: 'inc' }],
              },
            },
            settlement: { cause: 'timed-out', budgetMs: 1_000 },
          },
          {
            label: 'provider proxy lifecycle fatal incident 3',
            remainder: { owner: 'successor-recovery', evidence: { kind: 'startup-store-recovery' } },
            settlement: { cause: 'budget-exhausted' },
          },
          {
            label: 'unrecognized obligation',
            remainder: { owner: 'successor-recovery', evidence: { kind: 'startup-liveness-recovery' } },
            settlement: { cause: 'unconfirmed', detail: 'x' },
          },
          // Missing `settlement` fails whole-entry decode, exercising the skippedEntries projection instead.
          { label: 'stream response close 5', remainder: { owner: 'process-exit' } },
          { label: 'provider proxy lifecycle fatal incident 4', remainder: { owner: 'successor-recovery' } },
          { label: 'forged\nlabel', remainder: { owner: 'process-exit' } },
        ]),
      ),
    ];

    const { getBackendStatusFull } = await import('#src/transport/http/backend/status.js');
    const result = await getBackendStatusFull('/plugin-root');
    const remainder = recentShutdownRemainder(result);

    const paths = new Set<string>();
    collectLeafPaths(remainder, '', paths);

    expect([...paths].sort()).toEqual(
      [
        'status',
        'record.instanceId',
        'record.recordedAt',
        'record.reason',
        'record.mode',
        'record.entries[].entryNumber',
        'record.entries[].obligation',
        'record.entries[].obligation.label',
        'record.entries[].obligation.ordinal',
        'record.entries[].obligation.occurrence',
        'record.entries[].subject.kind',
        'record.entries[].subject.sourceDigest',
        'record.entries[].remainder.owner',
        'record.entries[].remainder.evidence.kind',
        'record.entries[].remainder.evidence.processes[].kind',
        'record.entries[].remainder.evidence.processes[].jobId',
        'record.entries[].remainder.evidence.processes[].pid',
        'record.entries[].remainder.evidence.processes[].leaderIncarnation.present',
        'record.entries[].settlement.cause',
        'record.entries[].settlement.error.name',
        'record.entries[].settlement.error.code',
        'record.entries[].settlement.budgetMs',
        'skippedEntries[].entryNumber',
        'skippedEntries[].obligation',
        'skippedEntries[].obligation.label',
        'skippedEntries[].obligation.ordinal',
        'skippedEntries[].obligation.occurrence',
        'skippedEntries[].owner',
        'skippedUnreadableRecordNames[]',
        'skippedCorruptRecordCount',
        'skippedUnsupportedRecordCount',
        'quarantined[].subject',
        'quarantined[].retry.trigger',
      ].sort(),
    );
    expect(JSON.stringify(result)).not.toContain('owner/repo');
  });

  it('projects ordinary runtime errnos from the platform registry', async () => {
    const codes = ['EMFILE', 'ENFILE', 'EIO', 'ENOMEM', 'EDQUOT', 'ELOOP', 'ENAMETOOLONG'] as const;
    mockState.remainderFiles = [
      remainderFile(
        'current.json',
        NOW - 10_000,
        shutdownRemainder(
          'current',
          NOW - 10_000,
          codes.map((code) => ({
            label: 'hooks.onShutdown',
            remainder: { owner: 'process-exit' },
            settlement: { cause: 'rejected', error: { kind: 'error', name: 'Error', code, message: 'failed' } },
          })),
        ),
      ),
    ];

    const { getBackendStatusFull } = await import('#src/transport/http/backend/status.js');
    const result = await getBackendStatusFull('/plugin-root');

    expect(recentShutdownRemainder(result)?.record.entries ?? []).toEqual(
      codes.map((code, index) => ({
        entryNumber: index + 1,
        obligation: { label: 'hooks.onShutdown' },
        remainder: { owner: 'process-exit' },
        settlement: { cause: 'rejected', error: { name: 'Error', code } },
      })),
    );
  });

  it('preserves entry numbers across entries this build skips', async () => {
    mockState.remainderFiles = [
      remainderFile(
        'current.json',
        NOW - 10_000,
        shutdownRemainder('current', NOW - 10_000, [
          {
            label: 'future obligation',
            remainder: { owner: 'future-owner' },
            settlement: { cause: 'unconfirmed', detail: 'future detail' },
          },
          shutdownRemainderEntry('hooks.onShutdown', 'process-exit', 'timed-out'),
        ]),
      ),
    ];

    const { getBackendStatusFull } = await import('#src/transport/http/backend/status.js');

    await expect(getBackendStatusFull('/plugin-root')).resolves.toMatchObject({
      status: 'no_record_no_socket',
      shutdownRemainder: {
        status: 'recent_shutdown_remainder',
        record: { entries: [{ entryNumber: 2, obligation: { label: 'hooks.onShutdown' } }] },
        skippedEntries: [{ entryNumber: 1, obligation: null, owner: null }],
      },
    });
  });

  it('projects the recovered owner of skipped entries', async () => {
    mockState.remainderFiles = [
      remainderFile(
        'current.json',
        NOW - 10_000,
        shutdownRemainder('current', NOW - 10_000, [
          {
            label: 'child termination',
            remainder: { owner: 'successor-recovery' },
            settlement: { cause: 'timed-out' },
          },
          {
            label: 'child termination',
            remainder: { owner: 'process-exit' },
            settlement: { cause: 'timed-out' },
          },
        ]),
      ),
    ];

    const { getBackendStatusFull } = await import('#src/transport/http/backend/status.js');

    await expect(getBackendStatusFull('/plugin-root')).resolves.toMatchObject({
      status: 'no_record_no_socket',
      shutdownRemainder: {
        status: 'recent_shutdown_remainder',
        skippedEntries: [
          { entryNumber: 1, obligation: { label: 'child termination' }, owner: 'successor-recovery' },
          { entryNumber: 2, obligation: { label: 'child termination' }, owner: 'process-exit' },
        ],
      },
    });
  });

  it('bounds public error identifiers without discarding repository error names and codes', async () => {
    mockState.remainderFiles = [
      remainderFile(
        'current.json',
        NOW - 10_000,
        shutdownRemainder('current', NOW - 10_000, [
          {
            label: 'hooks.onShutdown',
            remainder: { owner: 'process-exit' },
            settlement: {
              cause: 'rejected',
              error: {
                kind: 'error',
                name: 'ProviderOperationTerminalizationUnavailableError',
                code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
                message: 'bounded identifier fixture',
              },
            },
          },
          {
            label: 'hooks.onShutdown',
            remainder: { owner: 'process-exit' },
            settlement: {
              cause: 'rejected',
              error: { kind: 'error', name: 'A'.repeat(65), code: 'E'.repeat(65), message: 'overlong identifiers' },
            },
          },
        ]),
      ),
    ];

    const { getBackendStatusFull } = await import('#src/transport/http/backend/status.js');
    const result = await getBackendStatusFull('/plugin-root');

    expect(recentShutdownRemainder(result)?.record.entries[0]?.settlement ?? null).toEqual({
      cause: 'rejected',
      error: {
        name: 'ProviderOperationTerminalizationUnavailableError',
        code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
      },
    });
    expect(recentShutdownRemainder(result)?.record.entries[1]?.settlement ?? null).toEqual({
      cause: 'rejected',
      error: {},
    });
  });

  // Boundary occurrences that cross the leading-1 digit (10, 19, 99, 100) are the direct measurement for the
  // `[1-9][0-9]*` fix: `[2-9][0-9]*` rejected all of them, so this regresses to `obligation: null` on the old
  // pattern.
  it('projects dynamic obligation ordinals as numbers, including occurrences crossing the leading-1 boundary', async () => {
    mockState.remainderFiles = [
      remainderFile(
        'current.json',
        NOW - 10_000,
        shutdownRemainder('current', NOW - 10_000, [
          shutdownRemainderEntry('stream response close 12', 'process-exit', 'timed-out'),
          shutdownRemainderEntry('provider proxy lifecycle fatal incident 2', 'process-exit', 'rejected'),
          shutdownRemainderEntry('provider proxy lifecycle fatal incident 9', 'process-exit', 'rejected'),
          shutdownRemainderEntry('provider proxy lifecycle fatal incident 10', 'process-exit', 'rejected'),
          shutdownRemainderEntry('provider proxy lifecycle fatal incident 19', 'process-exit', 'rejected'),
          shutdownRemainderEntry('provider proxy lifecycle fatal incident 99', 'process-exit', 'rejected'),
          shutdownRemainderEntry('provider proxy lifecycle fatal incident 100', 'process-exit', 'rejected'),
          shutdownRemainderEntry('store epoch sweep cancellation', 'process-exit', 'timed-out'),
        ]),
      ),
    ];

    const { getBackendStatusFull } = await import('#src/transport/http/backend/status.js');

    await expect(getBackendStatusFull('/plugin-root')).resolves.toMatchObject({
      status: 'no_record_no_socket',
      shutdownRemainder: {
        status: 'recent_shutdown_remainder',
        record: {
          entries: [
            { obligation: { label: 'stream response close', ordinal: 12 } },
            { obligation: { label: 'provider proxy lifecycle fatal incident', occurrence: 2 } },
            { obligation: { label: 'provider proxy lifecycle fatal incident', occurrence: 9 } },
            { obligation: { label: 'provider proxy lifecycle fatal incident', occurrence: 10 } },
            { obligation: { label: 'provider proxy lifecycle fatal incident', occurrence: 19 } },
            { obligation: { label: 'provider proxy lifecycle fatal incident', occurrence: 99 } },
            { obligation: { label: 'provider proxy lifecycle fatal incident', occurrence: 100 } },
            { obligation: { label: 'store epoch sweep cancellation' } },
          ],
        },
      },
    });
  });

  it('selects a fresh record by recordedAt when its file metadata is unavailable', async () => {
    mockState.remainderFiles = [
      remainderFile('fresh.json', NOW - 20_000, shutdownRemainder('fresh', NOW - 10_000), 'EIO'),
      remainderFile('stale.json', NOW - 10_000, shutdownRemainder('stale', NOW - 300_001)),
    ];

    const { getBackendStatusFull } = await import('#src/transport/http/backend/status.js');

    await expect(getBackendStatusFull('/plugin-root')).resolves.toMatchObject({
      status: 'no_record_no_socket',
      shutdownRemainder: { status: 'recent_shutdown_remainder', record: { instanceId: 'fresh' } },
    });
  });

  it('reports files when every shutdown remainder record is corrupt or unsupported', async () => {
    mockState.remainderFiles = [
      remainderFile('corrupt.json', NOW - 10_000, '{not-json'),
      remainderFile('future.json', NOW - 5_000, JSON.stringify({ version: 2 })),
    ];

    const { getBackendStatusFull } = await import('#src/transport/http/backend/status.js');

    await expect(getBackendStatusFull('/plugin-root')).resolves.toEqual({
      status: 'no_record_no_socket',
      shutdownRemainder: {
        status: 'shutdown_remainder_unreadable',
        reason: 'records-skipped',
        skippedUnreadableRecordNames: [],
        skippedCorruptRecordCount: 1,
        skippedUnsupportedRecordCount: 1,
        quarantined: [{ subject: 'future.json', retry: { trigger: 'coordinator-startup' } }],
      },
    });
  });

  it('reports an undecodable shutdown remainder even when another readable record is stale', async () => {
    mockState.remainderFiles = [
      remainderFile('stale.json', NOW - 300_001, shutdownRemainder('stale', NOW - 300_001)),
      remainderFile('corrupt.json', NOW - 10_000, '{not-json'),
    ];

    const { getBackendStatusFull } = await import('#src/transport/http/backend/status.js');

    await expect(getBackendStatusFull('/plugin-root')).resolves.toEqual({
      status: 'no_record_no_socket',
      shutdownRemainder: {
        status: 'shutdown_remainder_unreadable',
        reason: 'records-skipped',
        skippedUnreadableRecordNames: [],
        skippedCorruptRecordCount: 1,
        skippedUnsupportedRecordCount: 0,
      },
    });
  });

  // A decisive decode failure is destroyed regardless of age by `pruneShutdownRemainderRecords` at the next
  // coordinator startup, so excluding it here on age too would mean no status read ever carries it before that
  // destruction (design-philosophy.md principle 11 — a refusal must be visible as durable status).
  it('reports an undecodable shutdown remainder outside the recent-record window', async () => {
    mockState.remainderFiles = [remainderFile('corrupt.json', NOW - 300_001, '{not-json')];

    const { getBackendStatusFull } = await import('#src/transport/http/backend/status.js');

    await expect(getBackendStatusFull('/plugin-root')).resolves.toEqual({
      status: 'no_record_no_socket',
      shutdownRemainder: {
        status: 'shutdown_remainder_unreadable',
        reason: 'records-skipped',
        skippedUnreadableRecordNames: [],
        skippedCorruptRecordCount: 1,
        skippedUnsupportedRecordCount: 0,
      },
    });
  });

  it('counts a stale undecodable record beside a recent readable remainder', async () => {
    mockState.remainderFiles = [
      remainderFile('corrupt.json', NOW - 300_001, '{not-json'),
      remainderFile('current.json', NOW - 10_000, shutdownRemainder('current', NOW - 10_000)),
    ];

    const { getBackendStatusFull } = await import('#src/transport/http/backend/status.js');

    await expect(getBackendStatusFull('/plugin-root')).resolves.toMatchObject({
      status: 'no_record_no_socket',
      shutdownRemainder: {
        status: 'recent_shutdown_remainder',
        record: { instanceId: 'current' },
        skippedUnreadableRecordNames: [],
        skippedCorruptRecordCount: 1,
      },
    });
  });

  it('reports EACCES when existsSync masks an inaccessible remainder directory as absent', async () => {
    mockState.remainderScanErrorCode = 'EACCES';

    const { getBackendStatusFull } = await import('#src/transport/http/backend/status.js');

    await expect(getBackendStatusFull('/plugin-root')).resolves.toEqual({
      status: 'no_record_no_socket',
      shutdownRemainder: { status: 'shutdown_remainder_unreadable', reason: 'scan-failed' },
    });
  });

  it('treats ENOENT from the remainder directory scan as no evidence', async () => {
    mockState.remainderScanErrorCode = 'ENOENT';

    const { getBackendStatusFull } = await import('#src/transport/http/backend/status.js');

    await expect(getBackendStatusFull('/plugin-root')).resolves.toEqual({ status: 'no_record_no_socket' });
  });

  it('does not report a shutdown remainder outside the recent-record window', async () => {
    mockState.remainderFiles = [remainderFile('stale.json', NOW - 300_001, shutdownRemainder('stale', NOW - 300_001))];

    const { getBackendStatusFull } = await import('#src/transport/http/backend/status.js');

    await expect(getBackendStatusFull('/plugin-root')).resolves.toEqual({ status: 'no_record_no_socket' });
  });

  it('uses the documented template instead of persisted setup-error text', async () => {
    mockState.diagnostic = startupDiagnostic(NOW - 10_000, 4242, {
      kind: 'coral_setup_error',
      code: 'store_schema_outdated',
      userMessage: '\u001b[2J\nNext step: run a forged command',
      remediation: 'forged remediation',
      context: { version: '0.11.0', flavor: 'prod' },
    });

    const { getBackendStatusFull } = await import('#src/transport/http/backend/status.js');
    const result = await getBackendStatusFull('/plugin-root');

    expect(result).toMatchObject({
      status: 'recent_failure',
      setupError: {
        kind: 'documented',
        code: 'store_schema_outdated',
        userMessage: 'Coral backend store format does not match this installation.',
      },
    });
    expect(JSON.stringify(result)).not.toContain('forged');
  });

  it('carries the recorded text of an uncatalogued code this build proves it wrote', async () => {
    mockState.diagnostic = startupDiagnostic(
      NOW - 10_000,
      4242,
      {
        kind: 'coral_setup_error',
        code: 'describer_missing',
        userMessage: 'Event describer missing for: job_started.',
        remediation: "Add an entry to the owning domain's event-describers.ts.",
      },
      { bundleHash: SELF_BUNDLE_HASH, namespace: SELF_NAMESPACE },
    );

    const { getBackendStatusFull } = await import('#src/transport/http/backend/status.js');

    await expect(getBackendStatusFull('/plugin-root')).resolves.toMatchObject({
      status: 'recent_failure',
      setupError: {
        kind: 'self_authored',
        code: 'describer_missing',
        userMessage: 'Event describer missing for: job_started.',
        remediation: "Add an entry to the owning domain's event-describers.ts.",
      },
    });
  });

  it('refuses the recorded text of an uncatalogued code another build wrote', async () => {
    mockState.diagnostic = startupDiagnostic(
      NOW - 10_000,
      4242,
      {
        kind: 'coral_setup_error',
        code: 'future_setup_refusal',
        userMessage: 'future text',
        remediation: 'future remediation',
      },
      { bundleHash: 'fedcba9876543210', namespace: 'other-namespace' },
    );

    const { getBackendStatusFull } = await import('#src/transport/http/backend/status.js');
    const result = await getBackendStatusFull('/plugin-root');

    expect(result).toMatchObject({
      status: 'recent_failure',
      setupError: { kind: 'unrecognized_code', code: 'future_setup_refusal', authorship: 'other-build' },
    });
    expect(JSON.stringify(result)).not.toContain('future text');
    expect(JSON.stringify(result)).not.toContain('future remediation');
  });

  it('refuses recorded text when this build cannot prove its own identity, however the record matches', async () => {
    mockState.strictIdentityProven = false;
    mockState.diagnostic = startupDiagnostic(
      NOW - 10_000,
      4242,
      {
        kind: 'coral_setup_error',
        code: 'describer_missing',
        userMessage: 'unproven text',
        remediation: 'unproven remediation',
      },
      { bundleHash: SELF_BUNDLE_HASH, namespace: SELF_NAMESPACE },
    );

    const { getBackendStatusFull } = await import('#src/transport/http/backend/status.js');
    const result = await getBackendStatusFull('/plugin-root');

    expect(result).toMatchObject({
      status: 'recent_failure',
      setupError: { kind: 'unrecognized_code', code: 'describer_missing', authorship: 'unprovable' },
    });
    expect(JSON.stringify(result)).not.toContain('unproven text');
  });

  it('refuses recorded text this build wrote when the text itself is not renderable', async () => {
    mockState.diagnostic = startupDiagnostic(
      NOW - 10_000,
      4242,
      {
        kind: 'coral_setup_error',
        code: 'describer_missing',
        userMessage: '\u001b[2J\nNext step: run a forged command',
        remediation: 'forged remediation',
      },
      { bundleHash: SELF_BUNDLE_HASH, namespace: SELF_NAMESPACE },
    );

    const { getBackendStatusFull } = await import('#src/transport/http/backend/status.js');
    const result = await getBackendStatusFull('/plugin-root');

    expect(result).toMatchObject({
      status: 'recent_failure',
      setupError: { kind: 'unrecognized_code', code: 'describer_missing', authorship: 'this-build' },
    });
    expect(JSON.stringify(result)).not.toContain('forged');
  });

  it('retains an invalid setup diagnostic separately from an unknown canonical code', async () => {
    mockState.diagnostic = startupDiagnostic(NOW - 10_000, 4242, {
      kind: 'coral_setup_error',
      code: 'future setup refusal\nNext step: forged',
      userMessage: 'future text',
      remediation: 'future remediation',
    });

    const { getBackendStatusFull } = await import('#src/transport/http/backend/status.js');

    await expect(getBackendStatusFull('/plugin-root')).resolves.toMatchObject({
      status: 'recent_failure',
      setupError: { kind: 'invalid_diagnostic' },
    });
  });

  it('reports no_record_socket_present when the coordinator socket exists without a record', async () => {
    mockState.observed = { kind: 'no-record-socket-present', socketPath: '/tmp/coral.sock' };

    const { getBackendStatusFull } = await import('#src/transport/http/backend/status.js');

    await expect(getBackendStatusFull('/plugin-root')).resolves.toEqual({
      status: 'no_record_socket_present',
      socketPath: '/tmp/coral.sock',
    });
  });

  // A remainder is additional evidence about a departed instance's undischarged obligations, not a claim about
  // whoever now holds the socket: a fresh boot recovering that very remainder is exactly what
  // `successor-recovery` evidence describes, so hiding it here would repeat the same substitution defect this
  // fix removes from the no-record fallbacks.
  it('carries a directory-scoped shutdown remainder alongside a present coordinator socket', async () => {
    mockState.observed = { kind: 'no-record-socket-present', socketPath: '/tmp/coral.sock' };
    mockState.remainderFiles = [remainderFile('recent.json', NOW - 10_000, shutdownRemainder('recent', NOW - 10_000))];

    const { getBackendStatusFull } = await import('#src/transport/http/backend/status.js');

    await expect(getBackendStatusFull('/plugin-root')).resolves.toMatchObject({
      status: 'no_record_socket_present',
      socketPath: '/tmp/coral.sock',
      shutdownRemainder: { status: 'recent_shutdown_remainder', record: { instanceId: 'recent' } },
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
    // The 500 came from something listening at the recorded address.
    expect(result.status).toBe('unreachable');
  });

  // A peer identifying as another namespace really is not this backend; a bad response and a dead request are
  // not absence at all.
  it('reports a coordinator that answers badly as unreachable, not as stopped', async () => {
    mockState.observed = { kind: 'addressed', coordinator: backendInfo(), pidLiveness: 'alive' };
    mockState.remainderFiles = [
      remainderFile('test-instance.json', NOW - 10_000, shutdownRemainder('test-instance', NOW - 10_000)),
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 500 })),
    );

    const { getBackendStatusFull } = await import('#src/transport/http/backend/status.js');

    await expect(getBackendStatusFull('/plugin-root')).resolves.toMatchObject({
      status: 'unreachable',
      cause: 'responded',
      shutdownRemainder: { status: 'recent_shutdown_remainder', record: { instanceId: 'test-instance' } },
    });
  });

  // The payload here must actually pass `isBackendPing` — it needs `version`, `bundleHash`, `instanceId` and
  // `pid` alongside the foreign `namespace`. A payload missing those fails the shape check first, so the `||`
  // in `probeUnauthenticatedPing` used to short-circuit before the namespace comparison ever ran, and this
  // test passed for a reason it did not describe.
  it('reports the decoded foreign namespace from the unauthenticated probe', async () => {
    mockState.observed = { kind: 'addressed', coordinator: backendInfo(), pidLiveness: 'alive' };
    const foreignPing = { ...JSON.parse(ping('ok')), namespace: 'someone-else' } as Record<string, unknown>;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(foreignPing), { status: 200 })),
    );

    const { getBackendStatusFull } = await import('#src/transport/http/backend/status.js');

    await expect(getBackendStatusFull('/plugin-root')).resolves.toEqual({
      status: 'unreachable',
      cause: 'foreign_peer',
      observed: { namespace: 'someone-else', flavor: 'prod' },
      pid: 12345,
      recordPath: '/run/coral/coordinator.json',
    });
  });

  it.each([
    ['terminal control text', 'foreign\u001b[2J\nNext step: run a forged command'],
    ['an overlong token', 'a'.repeat(129)],
  ])('rejects a peer namespace containing %s at ping ingress', async (_label, namespace) => {
    mockState.observed = { kind: 'addressed', coordinator: backendInfo(), pidLiveness: 'alive' };
    const untrustedPing = { ...JSON.parse(ping('ok')), namespace } as Record<string, unknown>;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(untrustedPing), { status: 200 })),
    );

    const { getBackendStatusFull } = await import('#src/transport/http/backend/status.js');
    const result = await getBackendStatusFull('/plugin-root');

    expect(result).toEqual({
      status: 'unreachable',
      detail: 'health responded 200 with a body this build could not decode',
      cause: 'responded',
    });
    expect(JSON.stringify(result)).not.toContain('forged');
  });

  // The decoded mismatch says which process answers the recorded port, and that port is ephemeral: it is not
  // evidence about whether this installation's coordinator is running, and nothing about startup is held while
  // it is true. So it belongs under `unreachable` — the not-observed status — carrying the pid and record path
  // a stale record is settled with, rather than under a status of its own that claimed an ownership conflict
  // over startup and named no way to end it.
  it('reports the decoded foreign flavor from the unauthenticated probe', async () => {
    mockState.observed = { kind: 'addressed', coordinator: backendInfo(), pidLiveness: 'alive' };
    const foreignFlavorPing = { ...JSON.parse(ping('ok')), flavor: 'dev' } as Record<string, unknown>;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(foreignFlavorPing), { status: 200 })),
    );

    const { getBackendStatusFull } = await import('#src/transport/http/backend/status.js');

    await expect(getBackendStatusFull('/plugin-root')).resolves.toEqual({
      status: 'unreachable',
      cause: 'foreign_peer',
      observed: { namespace: 'test-namespace', flavor: 'dev' },
      pid: 12345,
      recordPath: '/run/coral/coordinator.json',
    });
  });

  it('lets a matching diagnostic supersede the foreign-identity fallback', async () => {
    mockState.observed = { kind: 'addressed', coordinator: backendInfo(), pidLiveness: 'alive' };
    mockState.diagnostic = startupDiagnostic(NOW - 10_000, 12345);
    const foreignPing = { ...JSON.parse(ping('ok')), namespace: 'someone-else' } as Record<string, unknown>;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(foreignPing), { status: 200 })),
    );

    const { getBackendStatusFull } = await import('#src/transport/http/backend/status.js');

    await expect(getBackendStatusFull('/plugin-root')).resolves.toMatchObject({
      status: 'recent_failure',
      phase: 'startup_failed',
    });
  });

  // A diagnostic that supersedes the foreign-identity fallback is proof about this build's own departed
  // instance, not about the foreign peer, so it must still carry that instance's own shutdown remainder —
  // exactly like every other fallback member's `recent_failure` supersession.
  it("attaches the departed instance's own remainder to a diagnostic that supersedes the foreign-identity fallback", async () => {
    mockState.observed = { kind: 'addressed', coordinator: backendInfo(), pidLiveness: 'alive' };
    mockState.diagnostic = startupDiagnostic(NOW - 10_000, 12345);
    mockState.remainderFiles = [
      remainderFile('test-instance.json', NOW - 5_000, shutdownRemainder('test-instance', NOW - 5_000)),
    ];
    const foreignPing = { ...JSON.parse(ping('ok')), namespace: 'someone-else' } as Record<string, unknown>;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(foreignPing), { status: 200 })),
    );

    const { getBackendStatusFull } = await import('#src/transport/http/backend/status.js');

    await expect(getBackendStatusFull('/plugin-root')).resolves.toMatchObject({
      status: 'recent_failure',
      phase: 'startup_failed',
      shutdownRemainder: {
        status: 'recent_shutdown_remainder',
        record: { instanceId: 'test-instance' },
        skippedUnreadableRecordNames: [],
        skippedCorruptRecordCount: 0,
      },
    });
  });

  it('does not let an earlier coordinator remainder hide the foreign-identity evidence', async () => {
    mockState.observed = {
      kind: 'addressed',
      coordinator: backendInfo({ startedAt: NOW - 5_000 }),
      pidLiveness: 'alive',
    };
    mockState.remainderFiles = [remainderFile('recent.json', NOW - 10_000, shutdownRemainder('recent', NOW - 10_000))];
    const foreignPing = { ...JSON.parse(ping('ok')), namespace: 'someone-else' };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(foreignPing), { status: 200 })),
    );

    const { getBackendStatusFull } = await import('#src/transport/http/backend/status.js');

    await expect(getBackendStatusFull('/plugin-root')).resolves.toEqual({
      status: 'unreachable',
      cause: 'foreign_peer',
      observed: { namespace: 'someone-else', flavor: 'prod' },
      pid: 12345,
      recordPath: '/run/coral/coordinator.json',
    });
  });

  it('reports an exact-instance remainder alongside the live foreign peer', async () => {
    mockState.observed = {
      kind: 'addressed',
      coordinator: backendInfo({ startedAt: NOW - 20_000, instanceId: 'recorded-coordinator' }),
      pidLiveness: 'alive',
    };
    mockState.remainderFiles = [
      remainderFile('recorded-coordinator.json', NOW - 5_000, shutdownRemainder('recorded-coordinator', NOW - 5_000)),
    ];
    const foreignPing = { ...JSON.parse(ping('ok')), namespace: 'someone-else' };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(foreignPing), { status: 200 })),
    );

    const { getBackendStatusFull } = await import('#src/transport/http/backend/status.js');

    await expect(getBackendStatusFull('/plugin-root')).resolves.toEqual({
      status: 'unreachable',
      cause: 'foreign_peer',
      observed: { namespace: 'someone-else', flavor: 'prod' },
      pid: 12345,
      recordPath: '/run/coral/coordinator.json',
      shutdownRemainder: {
        status: 'recent_shutdown_remainder',
        record: expect.objectContaining({ instanceId: 'recorded-coordinator' }),
        skippedEntries: [],
        skippedUnreadableRecordNames: [],
        skippedCorruptRecordCount: 0,
        skippedUnsupportedRecordCount: 0,
      },
    });
  });

  it('does not let another coordinator remainder hide the foreign-identity evidence', async () => {
    mockState.observed = {
      kind: 'addressed',
      coordinator: backendInfo({ startedAt: NOW - 20_000, instanceId: 'recorded-coordinator' }),
      pidLiveness: 'alive',
    };
    mockState.remainderFiles = [
      remainderFile('other.json', NOW - 10_000, shutdownRemainder('other-coordinator', NOW - 10_000)),
    ];
    const foreignPing = { ...JSON.parse(ping('ok')), namespace: 'someone-else' };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(foreignPing), { status: 200 })),
    );

    const { getBackendStatusFull } = await import('#src/transport/http/backend/status.js');

    await expect(getBackendStatusFull('/plugin-root')).resolves.toEqual({
      status: 'unreachable',
      cause: 'foreign_peer',
      observed: { namespace: 'someone-else', flavor: 'prod' },
      pid: 12345,
      recordPath: '/run/coral/coordinator.json',
    });
  });

  it('reports unreachable for a 200 ping body this build cannot decode', async () => {
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
    'reports the %s record as its own status while retaining directory-scoped remainder evidence',
    async (reason) => {
      mockState.observed = { kind: 'unreadable-record', reason, path: '/run/coral/coordinator.json' };
      mockState.remainderFiles = [
        remainderFile('recent.json', NOW - 10_000, shutdownRemainder('recent', NOW - 10_000)),
      ];
      // The record-derived view is still populated here, so a consumer reading only that would fall through to
      // the liveness check and manufacture an absence.

      const { getBackendStatusFull } = await import('#src/transport/http/backend/status.js');

      await expect(getBackendStatusFull('/plugin-root')).resolves.toEqual({
        status: 'undecodable_record',
        reason,
        path: '/run/coral/coordinator.json',
        shutdownRemainder: {
          status: 'recent_shutdown_remainder',
          record: expect.objectContaining({ instanceId: 'recent' }),
          skippedEntries: [],
          skippedUnreadableRecordNames: [],
          skippedCorruptRecordCount: 0,
          skippedUnsupportedRecordCount: 0,
        },
      });
    },
  );
});

/** A well-formed startup diagnostic, so only the scoping fields under test decide whether it is accepted. */
function startupDiagnostic(
  recordedAt: number,
  pid: number,
  error: Record<string, unknown> = { kind: 'other' },
  identity?: { bundleHash: string; namespace: string },
): string {
  return JSON.stringify({
    schemaVersion: 1,
    state: 'stopped_with_diagnostic',
    retryable: false,
    phase: 'startup_failed',
    recordedAt: new Date(recordedAt).toISOString(),
    pid,
    ...(identity ?? {}),
    error,
  });
}

/**
 * The additive `shutdownRemainder` a `no_record_no_socket` / `recorded_process_absent` / `no_record_socket_present`
 * fallback carries, narrowed to the `recent_shutdown_remainder` report — `null` when there is none or the
 * fallback observed something a remainder cannot ride on.
 */
function recentShutdownRemainder(
  result: BackendStatusFull,
): Extract<ShutdownRemainderReport, { status: 'recent_shutdown_remainder' }> | null {
  const report = 'shutdownRemainder' in result ? result.shutdownRemainder : undefined;
  return report?.status === 'recent_shutdown_remainder' ? report : null;
}

function remainderFile(name: string, mtimeMs: number, value: string, statErrorCode?: string, readErrorCode?: string) {
  return { name, mtimeMs, value, statErrorCode, readErrorCode };
}

function shutdownRemainderEntry(
  label: string,
  owner: 'process-exit' | 'successor-recovery',
  cause: 'rejected' | 'timed-out',
) {
  return {
    label,
    remainder: owner === 'successor-recovery' ? { owner, evidence: { kind: 'startup-liveness-recovery' } } : { owner },
    settlement:
      cause === 'timed-out'
        ? { cause, budgetMs: 5_000 }
        : { cause, error: { kind: 'error', name: 'Error', message: 'hook failed' } },
  };
}

function shutdownRemainder(
  instanceId: string,
  recordedAt: number,
  entries: readonly unknown[] = [shutdownRemainderEntry('hooks.onShutdown', 'process-exit', 'rejected')],
): string {
  return JSON.stringify({
    instanceId,
    recordedAt: new Date(recordedAt).toISOString(),
    reason: 'sigterm',
    mode: 'handoff',
    entries,
  });
}

/**
 * Every key path reachable from a projected value, `[]` marking array descent — the runtime counterpart of
 * `ProjectionLeafPaths` in `tests/types/shutdown-remainder-status.test-d.ts`. Object-spread bypasses
 * TypeScript's excess-property check, so only walking the constructed value, never its declared type, can
 * prove no extra field reached it.
 */
function collectLeafPaths(value: unknown, prefix: string, paths: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectLeafPaths(item, `${prefix}[]`, paths);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      collectLeafPaths(child, prefix === '' ? key : `${prefix}.${key}`, paths);
    }
    return;
  }
  paths.add(prefix);
}

// An absent coordinator is the one case where a diagnostic is allowed to explain the absence, so it is also
// the one case where the wrong diagnostic becomes the reported cause. Two fields scope it and each admits
// something alone: a pid is reused by the OS, and a `startedAt` floor without a pid admits any run after it.
describe('getBackendStatusFull scopes a startup diagnostic to the coordinator that died', () => {
  const STARTED_AT = NOW - 100_000;
  const PID = 12_345;
  const INSTANCE_ID = 'dead-coordinator';

  beforeEach(() => {
    mockState.observed = { kind: 'process-absent', pid: PID, startedAt: STARTED_AT, instanceId: INSTANCE_ID };
    mockState.diagnostic = null;
    mockState.remainderFiles = [];
    mockState.cleanupRefusalState = null;
    mockState.remainderScanErrorCode = null;
    mockState.strictIdentityProven = true;
    mockState.stageLiveness = 'unknown';
  });

  it('reports a diagnostic recorded during this run', async () => {
    mockState.diagnostic = startupDiagnostic(STARTED_AT + 10_000, PID);

    const { getBackendStatusFull } = await import('#src/transport/http/backend/status.js');

    await expect(getBackendStatusFull('/plugin-root')).resolves.toMatchObject({
      status: 'recent_failure',
      phase: 'startup_failed',
    });
  });

  // Both the diagnostic and the remainder here name the exact same departed instance (`INSTANCE_ID`): this
  // proves the coordinator-scoped lookup attaches a matching-instance remainder, not that a *predecessor*
  // instance's remainder is reachable — the `coordinator !== undefined` scope requires an exact instance-id
  // match, which a genuine predecessor could never satisfy. See the directory-scoped case below for that.
  it('attaches the coordinator-scoped remainder of the exact instance a diagnostic explains', async () => {
    mockState.diagnostic = startupDiagnostic(STARTED_AT + 10_000, PID);
    mockState.remainderFiles = [
      remainderFile(`${INSTANCE_ID}.json`, NOW - 20_000, shutdownRemainder(INSTANCE_ID, NOW - 20_000)),
    ];

    const { getBackendStatusFull } = await import('#src/transport/http/backend/status.js');

    await expect(getBackendStatusFull('/plugin-root')).resolves.toMatchObject({
      status: 'recent_failure',
      phase: 'startup_failed',
      shutdownRemainder: {
        status: 'recent_shutdown_remainder',
        record: { instanceId: INSTANCE_ID },
        skippedUnreadableRecordNames: [],
        skippedCorruptRecordCount: 0,
      },
    });
  });

  it('reports a recent shutdown remainder when no scoped startup diagnostic exists', async () => {
    mockState.diagnostic = startupDiagnostic(STARTED_AT + 10_000, PID + 1);
    mockState.remainderFiles = [
      remainderFile(`${INSTANCE_ID}.json`, NOW - 20_000, shutdownRemainder(INSTANCE_ID, NOW - 20_000)),
      remainderFile('other-coordinator.json', NOW - 10_000, shutdownRemainder('other-coordinator', NOW - 10_000)),
    ];

    const { getBackendStatusFull } = await import('#src/transport/http/backend/status.js');

    await expect(getBackendStatusFull('/plugin-root')).resolves.toMatchObject({
      status: 'recorded_process_absent',
      pid: PID,
      shutdownRemainder: {
        status: 'recent_shutdown_remainder',
        record: { instanceId: INSTANCE_ID },
        skippedUnreadableRecordNames: [],
        skippedCorruptRecordCount: 0,
      },
    });
  });

  it('reports an undecodable remainder at the exact absent coordinator address', async () => {
    mockState.remainderFiles = [
      remainderFile(`${INSTANCE_ID}.json`, NOW - 10_000, '{not-json'),
      remainderFile('other-coordinator.json', NOW - 5_000, shutdownRemainder('other-coordinator', NOW - 5_000)),
    ];

    const { getBackendStatusFull } = await import('#src/transport/http/backend/status.js');

    await expect(getBackendStatusFull('/plugin-root')).resolves.toEqual({
      status: 'recorded_process_absent',
      pid: PID,
      shutdownRemainder: {
        status: 'shutdown_remainder_unreadable',
        reason: 'records-skipped',
        skippedUnreadableRecordNames: [],
        skippedCorruptRecordCount: 1,
        skippedUnsupportedRecordCount: 0,
      },
    });
  });

  it('reports failure to scan the exact absent coordinator remainder scope', async () => {
    mockState.remainderScanErrorCode = 'EACCES';

    const { getBackendStatusFull } = await import('#src/transport/http/backend/status.js');

    await expect(getBackendStatusFull('/plugin-root')).resolves.toEqual({
      status: 'recorded_process_absent',
      pid: PID,
      shutdownRemainder: { status: 'shutdown_remainder_unreadable', reason: 'scan-failed' },
    });
  });

  it('does not attach another coordinator skipped record to a readable scoped remainder', async () => {
    mockState.remainderFiles = [
      remainderFile(`${INSTANCE_ID}.json`, NOW - 20_000, shutdownRemainder(INSTANCE_ID, NOW - 20_000)),
      remainderFile('other-coordinator.json', NOW - 10_000, '{not-json', 'EIO'),
    ];

    const { getBackendStatusFull } = await import('#src/transport/http/backend/status.js');

    await expect(getBackendStatusFull('/plugin-root')).resolves.toMatchObject({
      status: 'recorded_process_absent',
      pid: PID,
      shutdownRemainder: {
        status: 'recent_shutdown_remainder',
        record: { instanceId: INSTANCE_ID },
        skippedUnreadableRecordNames: [],
        skippedCorruptRecordCount: 0,
      },
    });
  });

  it('ignores a prior coordinator remainder recorded before this coordinator started', async () => {
    // Same instance id as the scoped coordinator: only the `recordedAt >= scope.startedAt` guard this case is
    // named for can reject it. A different instance id (the prior fixture) is rejected by the identity check
    // first, so the timestamp guard is never exercised.
    mockState.remainderFiles = [
      remainderFile(`${INSTANCE_ID}.json`, STARTED_AT - 10_000, shutdownRemainder(INSTANCE_ID, STARTED_AT - 10_000)),
    ];

    const { getBackendStatusFull } = await import('#src/transport/http/backend/status.js');

    await expect(getBackendStatusFull('/plugin-root')).resolves.toEqual({
      status: 'recorded_process_absent',
      pid: PID,
    });
  });

  it('does not widen a discovery record without an instance id to directory-wide remainder evidence', async () => {
    mockState.observed = { kind: 'process-absent', pid: PID, startedAt: STARTED_AT };
    mockState.remainderFiles = [
      remainderFile('other.json', NOW - 10_000, shutdownRemainder('other-coordinator', NOW - 10_000)),
    ];

    const { getBackendStatusFull } = await import('#src/transport/http/backend/status.js');

    await expect(getBackendStatusFull('/plugin-root')).resolves.toEqual({
      status: 'recorded_process_absent',
      pid: PID,
    });
  });

  // Not knowing which instance to scope to (a legacy discovery record predates `instanceId`) is a different
  // unknown from not knowing whether the remainder directory could be read at all — the second one must never
  // collapse into the first's silence (design-philosophy.md principle 11's third answer).
  it('reports a scan failure even when the coordinator scope carries no instance id to widen', async () => {
    mockState.observed = { kind: 'process-absent', pid: PID, startedAt: STARTED_AT };
    mockState.remainderScanErrorCode = 'EACCES';

    const { getBackendStatusFull } = await import('#src/transport/http/backend/status.js');

    await expect(getBackendStatusFull('/plugin-root')).resolves.toEqual({
      status: 'recorded_process_absent',
      pid: PID,
      shutdownRemainder: { status: 'shutdown_remainder_unreadable', reason: 'scan-failed' },
    });
  });

  it('ignores one recorded before this coordinator started, even though the pid matches', async () => {
    // The recycled-pid case. Without the `startedAt` floor this reports a previous daemon's crash as the
    // explanation for a coordinator that exited cleanly minutes later.
    mockState.diagnostic = startupDiagnostic(STARTED_AT - 10_000, PID);

    const { getBackendStatusFull } = await import('#src/transport/http/backend/status.js');

    await expect(getBackendStatusFull('/plugin-root')).resolves.toEqual({
      status: 'recorded_process_absent',
      pid: PID,
    });
  });

  it('ignores one recorded during this run by a different pid', async () => {
    mockState.diagnostic = startupDiagnostic(STARTED_AT + 10_000, PID + 1);

    const { getBackendStatusFull } = await import('#src/transport/http/backend/status.js');

    await expect(getBackendStatusFull('/plugin-root')).resolves.toEqual({
      status: 'recorded_process_absent',
      pid: PID,
    });
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
function detailed(status: 'starting' | 'ok' | 'draining', extra: Readonly<Record<string, unknown>> = {}): string {
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
    ...extra,
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
    mockState.diagnostic = null;
    mockState.remainderFiles = [];
    mockState.strictIdentityProven = true;
  });

  // Unlike the first `describe` in this file, none of the tests below restored `fetch` on their own —
  // `vi.stubGlobal` is a process-wide replacement, so a stub any of them left behind would leak into whatever
  // ran next. Same reasoning as the note on the first `describe`'s `afterEach`.
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('preserves a running cleanup refusal through draining, exit, status, and restart', async () => {
    mockState.remainderFiles = [
      { name: 'corrupt.json', value: '{not-json', mtimeMs: NOW - 10_000, unlinkErrorCode: 'EACCES' },
    ];
    const { createRealRuntime } = await import('#src/runtime/real.js');
    const { createShutdownRemainderPruner } = await import('#src/coordinator/shutdown-remainder.js');
    const runtime = createRealRuntime('prod');
    const pruner = createShutdownRemainderPruner({
      storage: runtime.storage,
      runDir: runtime.paths.coral.coordinator.runDir,
      time: {
        setInterval: () => ({ unref: vi.fn() }),
        clearInterval: vi.fn(),
      },
    });

    expect(pruner.start()?.cleanup).toMatchObject({
      kind: 'refused',
      refusals: [
        {
          subject: 'corrupt.json',
          cause: { kind: 'system-error', operation: 'delete', code: 'EACCES' },
          retry: { trigger: 'remainder-maintenance', action: 'rescan-subject' },
          exit: { condition: 'cleanup-succeeded-or-subject-absent' },
        },
      ],
    });
    stubProbes(new Response(ping('ok'), { status: 200 }), new Response(detailed('ok'), { status: 200 }));

    const { getBackendStatusFull } = await import('#src/transport/http/backend/status.js');
    const result = await getBackendStatusFull('/plugin-root');

    expect(result).toMatchObject({
      status: 'ok',
      shutdownRemainder: {
        status: 'shutdown_remainder_unreadable',
        reason: 'records-skipped',
        skippedCorruptRecordCount: 1,
        cleanupRefusals: [
          {
            subject: 'corrupt.json',
            cause: { kind: 'system-error', operation: 'delete', code: 'EACCES' },
            retry: { trigger: 'remainder-maintenance', action: 'rescan-subject' },
            exit: { condition: 'cleanup-succeeded-or-subject-absent' },
          },
        ],
      },
    });

    pruner.stop();
    stubProbes(new Response(ping('draining'), { status: 200 }));
    await expect(getBackendStatusFull('/plugin-root')).resolves.toMatchObject({
      status: 'shutting_down',
      shutdownRemainder: { cleanupRefusals: [{ subject: 'corrupt.json' }] },
    });

    mockState.observed = {
      kind: 'process-absent',
      pid: 12_345,
      startedAt: 1,
      instanceId: 'test-instance',
    };
    await expect(getBackendStatusFull('/plugin-root')).resolves.toMatchObject({
      status: 'recorded_process_absent',
      shutdownRemainder: { cleanupRefusals: [{ subject: 'corrupt.json' }] },
    });

    const refused = mockState.remainderFiles[0];
    if (refused === undefined) throw new Error('refused subject disappeared');
    delete refused.unlinkErrorCode;
    const restarted = createShutdownRemainderPruner({
      storage: runtime.storage,
      runDir: runtime.paths.coral.coordinator.runDir,
      time: { setInterval: () => ({ unref: vi.fn() }), clearInterval: vi.fn() },
    });
    expect(restarted.start()?.cleanup).toEqual({ kind: 'complete' });
    expect(mockState.remainderFiles).toEqual([]);
  });

  it('reports a draining ping as shutting_down without asking the detailed probe', async () => {
    mockState.remainderFiles = [
      remainderFile('test-instance.json', NOW - 10_000, shutdownRemainder('test-instance', NOW - 10_000)),
    ];
    const fetchMock = stubProbes(new Response(ping('draining'), { status: 200 }));

    const { getBackendStatusFull } = await import('#src/transport/http/backend/status.js');

    await expect(getBackendStatusFull('/plugin-root')).resolves.toMatchObject({
      status: 'shutting_down',
      shutdownRemainder: { status: 'recent_shutdown_remainder', record: { instanceId: 'test-instance' } },
    });
    expect(fetchMock, 'the ping settled it; asking again could only disagree').toHaveBeenCalledTimes(1);
  });

  // 502/503/504 only: `TransientHttpError.isTransientStatus` is deliberately narrow, and 429 is *not* in it —
  // measured rather than assumed, after this table first guessed otherwise.
  it.each([[503], [502], [504]])('reports a %s ping as shutting_down, not as unreachable', async (status) => {
    stubProbes(new Response('{}', { status }));

    const { getBackendStatusFull } = await import('#src/transport/http/backend/status.js');

    await expect(getBackendStatusFull('/plugin-root')).resolves.toEqual({ status: 'shutting_down' });
  });

  it('reports a healthy detailed answer as ok while retaining a predecessor stage hold', async () => {
    mockState.remainderFiles = [
      remainderFile(
        'predecessor.json.stage.4242.unobserved',
        NOW - 10_000,
        shutdownRemainder('predecessor', NOW - 10_000),
      ),
    ];
    stubProbes(new Response(ping('ok'), { status: 200 }), new Response(detailed('ok'), { status: 200 }));

    const { getBackendStatusFull } = await import('#src/transport/http/backend/status.js');
    const result = await getBackendStatusFull('/plugin-root');

    expect(result.status).toBe('ok');
    expect(result, 'the version an operator sees comes from the daemon, not the record').toMatchObject({
      health: { status: 'ok', version: '0.0.0', instanceId: 'test-instance', uptimeMs: 1_000 },
      shutdownRemainder: {
        status: 'shutdown_remainder_unreadable',
        reason: 'records-skipped',
        staging: { writerAliveCount: 0, writerUnobservableCount: 1, orphanedCount: 0 },
      },
    });
  });

  it('keeps a detailed answer usable while carrying the count of provider proxy set rows it skipped', async () => {
    const understoodRow = {
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
      holds: [
        {
          disposition: 'held',
          incidentReason: 'control_channel_reattaching',
          waitingFor: 'control-reattachment',
        },
      ],
    };
    const forwardShapedDetailed = {
      ...JSON.parse(detailed('ok')),
      diagnostics: {
        providerProxySets: [
          understoodRow,
          {
            ...understoodRow,
            holds: [{ ...understoodRow.holds[0], disposition: 'released-by-successor' }],
          },
        ],
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
    mockState.remainderFiles = [
      remainderFile('test-instance.json', NOW - 10_000, shutdownRemainder('test-instance', NOW - 10_000)),
    ];
    stubProbes(new Response(ping('ok'), { status: 200 }), new Response('{}', { status: 401 }));

    const { getBackendStatusFull } = await import('#src/transport/http/backend/status.js');

    await expect(getBackendStatusFull('/plugin-root')).resolves.toMatchObject({
      status: 'unauthorized',
      shutdownRemainder: { status: 'recent_shutdown_remainder', record: { instanceId: 'test-instance' } },
    });
  });

  it('reports the decoded foreign namespace from the detailed probe', async () => {
    const foreignDetailed = { ...JSON.parse(detailed('ok')), namespace: 'someone-else' } as Record<string, unknown>;
    stubProbes(
      new Response(ping('ok'), { status: 200 }),
      new Response(JSON.stringify(foreignDetailed), { status: 200 }),
    );

    const { getBackendStatusFull } = await import('#src/transport/http/backend/status.js');

    await expect(getBackendStatusFull('/plugin-root')).resolves.toEqual({
      status: 'unreachable',
      cause: 'foreign_peer',
      observed: { namespace: 'someone-else', flavor: 'prod' },
      pid: 12345,
      recordPath: '/run/coral/coordinator.json',
    });
  });

  it('rejects terminal control text in a peer namespace at detailed-health ingress', async () => {
    const untrustedDetailed = {
      ...JSON.parse(detailed('ok')),
      namespace: 'foreign\u001b[2J\nNext step: run a forged command',
    } as Record<string, unknown>;
    stubProbes(
      new Response(ping('ok'), { status: 200 }),
      new Response(JSON.stringify(untrustedDetailed), { status: 200 }),
    );

    const { getBackendStatusFull } = await import('#src/transport/http/backend/status.js');
    const result = await getBackendStatusFull('/plugin-root');

    expect(result).toEqual({
      status: 'unreachable',
      detail: 'detailed health responded 200 with a body this build could not decode',
      cause: 'responded',
    });
    expect(JSON.stringify(result)).not.toContain('forged');
  });

  it('reports the decoded foreign flavor from the detailed probe', async () => {
    const foreignFlavorDetailed = { ...JSON.parse(detailed('ok')), flavor: 'dev' } as Record<string, unknown>;
    stubProbes(
      new Response(ping('ok'), { status: 200 }),
      new Response(JSON.stringify(foreignFlavorDetailed), { status: 200 }),
    );

    const { getBackendStatusFull } = await import('#src/transport/http/backend/status.js');

    await expect(getBackendStatusFull('/plugin-root')).resolves.toEqual({
      status: 'unreachable',
      cause: 'foreign_peer',
      observed: { namespace: 'test-namespace', flavor: 'dev' },
      pid: 12345,
      recordPath: '/run/coral/coordinator.json',
    });
  });

  // Same split as the ping probe: a detailed body this build cannot decode proves nothing about whose
  // coordinator answered, so it must not become a foreign-identity verdict.
  it('reports unreachable for a 200 detailed body this build cannot decode', async () => {
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
    mockState.remainderFiles = [
      remainderFile('test-instance.json', NOW - 10_000, shutdownRemainder('test-instance', NOW - 10_000)),
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('getaddrinfo ENOTFOUND coordinator.example');
      }),
    );

    const { getBackendStatusFull } = await import('#src/transport/http/backend/status.js');

    await expect(getBackendStatusFull('/plugin-root')).resolves.toMatchObject({
      status: 'unreachable',
      detail: 'getaddrinfo ENOTFOUND coordinator.example',
      cause: 'no_response',
      shutdownRemainder: { status: 'recent_shutdown_remainder', record: { instanceId: 'test-instance' } },
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
    mockState.remainderFiles = [
      remainderFile('test-instance.json', NOW - 10_000, shutdownRemainder('test-instance', NOW - 10_000)),
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw Object.assign(new TypeError('fetch failed'), {
          cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:4321'), { code: 'ECONNREFUSED' }),
        });
      }),
    );

    const { getBackendStatusFull } = await import('#src/transport/http/backend/status.js');

    await expect(getBackendStatusFull('/plugin-root')).resolves.toMatchObject({
      status: 'unreachable',
      detail: 'ECONNREFUSED',
      cause: 'refused',
      pidLiveness: 'alive',
      pid: 12345,
      recordPath: '/run/coral/coordinator.json',
      shutdownRemainder: { status: 'recent_shutdown_remainder', record: { instanceId: 'test-instance' } },
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
