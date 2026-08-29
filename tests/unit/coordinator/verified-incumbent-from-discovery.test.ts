// The one guard on the takeover path that a build-identity change can silently revert, and did.
//
// `verifiedIncumbentFromDiscovery` decides which discovery record this contender is contending with. Nothing
// else on the bind path re-derives that decision, and the credential it carries — `bootToken` — is what lets
// a contender ask an incumbent to stand down at all. An earlier revision required the record to carry an
// incarnation; a coordinator that predates the token writes none, so every such record was discarded along
// with its token, and the newer build died at the gate that exists to catch a missing credential. That is the
// deadlock the token was introduced to end, reinstated for the one upgrade that introduces it.
//
// It lived as an inline closure and had no test of its own: reverting the guard broke nothing. It is a named
// function now so this file can hold it.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type * as NodeOs from 'node:os';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  verifiedIncumbentFromDiscovery,
  verifiedIncumbentFromProbe,
  verifiedIncumbentFromRuntimeProbe,
} from '#src/coordinator/lifecycle.js';
import type { CoordinatorDiscoveryRecord, CoordinatorProbe, DiscoveryRuntime } from '#src/infra/backend-discovery.js';
import { createRealRuntime } from '#src/runtime/real.js';
import type { DesiredIncumbentIdentity, IncumbentHealth } from '#src/transport/ipc/handoff.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';

// Only `verifiedIncumbentFromRuntimeProbe`'s tests below touch the filesystem or `node:os`; every other test in
// this file passes hand-built values and never reaches either mock.
const mockState = vi.hoisted(() => ({ home: '' }));

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof NodeOs>('node:os');
  return { ...actual, homedir: () => mockState.home };
});

const SOCKET = '/tmp/coral-verified-incumbent.sock';

const DESIRED: DesiredIncumbentIdentity = {
  version: '0.11.0',
  bundleHash: 'contender-bundle',
  flavor: 'prod',
  namespace: 'ns',
};

/** Exactly what a build that predates the incarnation token leaves behind: a full record, and no `incarnation`. */
function preTokenRecord(overrides: Partial<CoordinatorDiscoveryRecord> = {}): CoordinatorDiscoveryRecord {
  return {
    pid: 4321,
    port: 0,
    socketPath: SOCKET,
    bundleHash: 'incumbent-bundle',
    flavor: 'prod',
    namespace: 'ns',
    startedAt: 1_700_000_000_000,
    token: 'incumbent-token',
    bootToken: 'incumbent-boot-token',
    shutdownToken: 'incumbent-shutdown-token',
    version: '0.10.8',
    instanceId: 'incumbent-instance',
    ...overrides,
  };
}

const evidence = (lastHealth: IncumbentHealth | null = null) => ({
  socketPath: SOCKET,
  desired: DESIRED,
  lastHealth,
});

describe('verifiedIncumbentFromDiscovery', () => {
  it('keeps a pre-token incumbent and the boot token beside it', () => {
    const incumbent = verifiedIncumbentFromDiscovery(preTokenRecord(), evidence());

    expect(incumbent, 'a record without an incarnation is still the incumbent').not.toBeNull();
    expect(incumbent?.bootToken, 'the credential that makes a peaceful handoff possible must survive').toBe(
      'incumbent-boot-token',
    );
    expect(incumbent?.incarnation).toBeUndefined();
  });

  it('carries an incarnation through when the incumbent published one', () => {
    const incarnation = testIncarnation(9_001);

    expect(verifiedIncumbentFromDiscovery(preTokenRecord({ incarnation }), evidence())?.incarnation).toBe(incarnation);
  });

  it('is not the incumbent when the record names another socket, flavor or namespace', () => {
    for (const record of [
      preTokenRecord({ socketPath: '/tmp/coral-other.sock' }),
      preTokenRecord({ flavor: 'dev' }),
      preTokenRecord({ namespace: 'other-ns' }),
    ]) {
      expect(verifiedIncumbentFromDiscovery(record, evidence())).toBeNull();
    }
    expect(verifiedIncumbentFromDiscovery(null, evidence())).toBeNull();
  });

  // `writeDiscoveryRecord` probes once and serializes nothing if that probe fails, so a perfectly ordinary
  // current build can publish a record without an incarnation. Signalling requires one, so if health's value
  // were discarded here that build would be unevictable — the guard against killing a stranger turned into a
  // guard against replacing a peer.
  it('takes the incarnation from health when the record has none', () => {
    const incarnation = testIncarnation(5_150);
    const health: IncumbentHealth = {
      flavor: 'prod',
      namespace: 'ns',
      bundleHash: 'incumbent-bundle',
      pid: 4321,
      incarnation,
    };

    const incumbent = verifiedIncumbentFromDiscovery(preTokenRecord(), evidence(health));

    expect(incumbent, 'health naming an incarnation the record omits is not a disagreement').not.toBeNull();
    expect(incumbent?.incarnation).toBe(incarnation);
  });

  // The pid is the only thing tying health's statement to the record's. Ping is unauthenticated, so the peer
  // answering is not required to be the incumbent — without the pid agreement a stale record naming a
  // recycled pid could take any live peer's incarnation and become signal-capable against a stranger.
  it('ignores health’s incarnation when health did not name the same pid', () => {
    const incarnation = testIncarnation(5_150);
    const base: IncumbentHealth = { flavor: 'prod', namespace: 'ns', bundleHash: 'incumbent-bundle' };

    expect(
      verifiedIncumbentFromDiscovery(preTokenRecord(), evidence({ ...base, incarnation }))?.incarnation,
      'health that names no pid has said nothing about this one',
    ).toBeUndefined();
    expect(
      verifiedIncumbentFromDiscovery(preTokenRecord(), evidence({ ...base, pid: 4321, incarnation }))?.incarnation,
      'the same pid is what makes it the same process',
    ).toBe(incarnation);
  });

  it('is not the incumbent when the record contradicts health read from the same socket', () => {
    const health: IncumbentHealth = { flavor: 'prod', namespace: 'ns', bundleHash: 'incumbent-bundle', pid: 4321 };

    expect(verifiedIncumbentFromDiscovery(preTokenRecord(), evidence(health))).not.toBeNull();
    expect(verifiedIncumbentFromDiscovery(preTokenRecord(), evidence({ ...health, pid: 9999 }))).toBeNull();
    expect(verifiedIncumbentFromDiscovery(preTokenRecord(), evidence({ ...health, bundleHash: 'other' }))).toBeNull();
    // Two statements that disagree, which is what a contradiction is. One statement and a silence is not.
    expect(
      verifiedIncumbentFromDiscovery(
        preTokenRecord({ incarnation: testIncarnation(1) }),
        evidence({ ...health, incarnation: testIncarnation(7) }),
      ),
    ).toBeNull();
  });
});

// The same closure-with-no-test failure, one call earlier. `verifiedIncumbentFromDiscovery` decides what to do
// with a record; this decides whether there is a record to decide about, and the difference between its two
// `null`s — nobody is there, versus the file could not be read — is the one the whole `CoordinatorProbe` type
// exists to keep apart. It was an inline closure on the bind path until this file could hold it.
describe('verifiedIncumbentFromProbe', () => {
  const probes: ReadonlyArray<readonly [string, CoordinatorProbe]> = [
    ['a live record', { kind: 'live', record: preTokenRecord() }],
    [
      'a record whose pid could not be observed',
      { kind: 'unobservable', reason: 'unreadable-process', record: preTokenRecord() },
    ],
  ];

  it.each(probes)('contends with the incumbent behind %s', (_label, probe) => {
    const incumbent = verifiedIncumbentFromProbe(probe, evidence());

    expect(incumbent, 'an unanswered pid probe is not the incumbent being absent').not.toBeNull();
    expect(incumbent?.bootToken, 'dropping the record drops the credential for a peaceful handoff').toBe(
      'incumbent-boot-token',
    );
  });

  it('has no incumbent to contend with when the probe observed absence', () => {
    expect(verifiedIncumbentFromProbe({ kind: 'absent' }, evidence())).toBeNull();
  });

  it('has no incumbent to contend with when the record could not be decoded', () => {
    // Not the same statement as the case above, and this call cannot say so — there is no record to agree
    // with, so `null` is the only value available. What keeps it from reading as "nobody is there" is outside
    // this function: `probeCoordinator` warns, and startup refuses the undecodable pre-bind disposition.
    expect(verifiedIncumbentFromProbe({ kind: 'unobservable', reason: 'unreadable-record' }, evidence())).toBeNull();
  });

  it('still applies the record checks it delegates', () => {
    // Guards against this becoming a pass-through: selecting the record is not accepting it.
    const mismatched: CoordinatorProbe = {
      kind: 'unobservable',
      reason: 'unreadable-process',
      record: preTokenRecord({ socketPath: '/tmp/coral-other.sock' }),
    };

    expect(verifiedIncumbentFromProbe(mismatched, evidence())).toBeNull();
  });
});

// The composition above is tested only against a `CoordinatorProbe` someone hand-built — never against a real
// `probeCoordinator` read, which is exactly the gap that let the incarnation guard revert with nothing failing
// (see the file header). This drives a real discovery directory through the same call `lifecycle.ts` wires
// into `bindWithHandoff` as `readVerifiedIncumbentFromDiscovery`.
describe('verifiedIncumbentFromRuntimeProbe', () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const root of tempRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function makeRuntime(): DiscoveryRuntime {
    const home = mkdtempSync(join(tmpdir(), 'coral-runtime-probe-home-'));
    tempRoots.push(home);
    mockState.home = home;
    const runtime = createRealRuntime('prod');
    return { storage: runtime.storage, env: runtime.env, paths: runtime.paths };
  }

  it('has no incumbent to contend with when no discovery record was ever written', () => {
    const runtime = makeRuntime();

    expect(verifiedIncumbentFromRuntimeProbe(runtime, evidence())).toBeNull();
  });

  it('has no incumbent to contend with when the discovery record cannot be decoded', () => {
    // Lifecycle startup calls the disposition reader before reaching this probe and refuses this state. This
    // direct helper test pins only the probe's narrower contract for its other callers.
    const runtime = makeRuntime();
    const infoFile = runtime.paths.coral.coordinator.infoFile;
    mkdirSync(dirname(infoFile), { recursive: true });
    writeFileSync(infoFile, '{"pid": 4242, "socketPath"', 'utf-8');

    expect(verifiedIncumbentFromRuntimeProbe(runtime, evidence())).toBeNull();
  });

  // The positive case, so this suite cannot pass by always returning `null`: a live, matching record probed
  // for real must still reach the incumbent, the same as `verifiedIncumbentFromProbe`'s own `'live'` case.
  it('contends with a live incumbent a real probe actually observed', async () => {
    const runtime = makeRuntime();
    const { writeDiscoveryRecord } = await import('#src/infra/backend-discovery.js');

    writeDiscoveryRecord(
      {
        pid: process.pid, // guaranteed observable: this is the test process's own pid
        port: 9024, // must be positive: unlike `preTokenRecord()`, this round-trips through the real schema
        socketPath: SOCKET,
        bundleHash: 'incumbent-bundle',
        flavor: 'prod',
        namespace: 'ns',
        startedAt: Date.now(),
        token: 'incumbent-token',
        bootToken: 'incumbent-boot-token',
      },
      runtime,
    );

    const incumbent = verifiedIncumbentFromRuntimeProbe(runtime, evidence());

    expect(incumbent, 'a live, matching record is an incumbent to contend with').not.toBeNull();
    expect(incumbent?.bootToken).toBe('incumbent-boot-token');
  });
});
