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

import { describe, expect, it } from 'vitest';

import { verifiedIncumbentFromDiscovery } from '#src/coordinator/lifecycle.js';
import type { CoordinatorDiscoveryRecord } from '#src/infra/backend-discovery.js';
import type { DesiredIncumbentIdentity, IncumbentHealth } from '#src/transport/ipc/handoff.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';

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
