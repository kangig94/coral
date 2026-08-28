import { createRecordedProcessObserver, type ProcessIncarnation } from '../../../infra/node-process.js';
import { createMonotonicClock } from '../../../infra/monotonic-clock.js';
import { reapRecordedContainment } from '../../../infra/process-containment.js';
import {
  MAX_PROXY_RECORDED_PROVIDER_ROOTS,
  providerProxyDisappearanceReceipt,
} from '../../../provider-proxy/enforcement.js';
import { PROXY_TEARDOWN_RESERVE_MS } from '../../../provider-proxy/orphan-deadline.js';
import type {
  ProviderProxySetContainmentProof,
  ProviderProxySetEnforcerObservations,
} from '../../../provider-proxy/set-containment-contract.js';
import type { Runtime } from '../../../runtime/ports.js';
import type { Database } from '../../../store/db.js';
import {
  attributeUnreadableProviderOperations,
  readProviderOperations,
} from '../../../store/provider-operation-journal.js';
import {
  providerProxySetIdentitiesEqual,
  providerProxySetIdentityFromRecord,
  type ProviderProxySetIdentity,
} from './identity.js';

const providerSetDisappearanceClockScope = Symbol('provider-set-disappearance');

export interface ProviderProxySetContainmentProver {
  proveContainmentAbsent(
    identity: ProviderProxySetIdentity,
    db: Database,
    signal: AbortSignal,
  ): Promise<ProviderProxySetContainmentProof>;
}

async function proveProviderProxySetContainmentAbsent(
  identity: ProviderProxySetIdentity,
  db: Database,
  runtime: Runtime,
  signal: AbortSignal,
): Promise<ProviderProxySetContainmentProof> {
  const platform = runtime.env.platform() as NodeJS.Platform;
  const operationScan = readProviderOperations(db);
  // An unreadable row may name another provider root for *this* set, and acting on the decoded subset would
  // let that root survive outside the process group while this function minted a disappearance receipt. So the
  // proof stays unknown — but only for the sets the row could belong to, which is asked of both its key and
  // its bytes. Those disagree exactly when the decode failed *because* they disagree, and a row attributable
  // from neither side could belong to any set, so it fences all of them.
  const hidesARootOfThisSet = attributeUnreadableProviderOperations(db, operationScan.unreadableKeys).some(
    ({ sets }) =>
      sets.kind === 'indeterminate' ||
      sets.values.some(
        (address) => address.proxyInstanceId === identity.proxyInstanceId && address.buildSetId === identity.buildSetId,
      ),
  );
  if (hidesARootOfThisSet) return { kind: 'store-unreadable' };

  const observeEnforcer = createRecordedProcessObserver({
    readIncarnation: (pid) => runtime.process.readProcessIncarnation(pid, platform),
    observeLiveness: (pid) => runtime.process.observeLiveness(pid),
  });
  // These identities were recorded by the enforcers. A different fresh incarnation proves that the pid now
  // belongs to someone else; only an absent observation discounts an enforcer before process-group reaping.
  const observations: ProviderProxySetEnforcerObservations = [
    {
      role: 'guardian',
      observation: observeEnforcer({
        pid: identity.guardianPid,
        incarnation: identity.guardianIncarnation,
      }),
    },
    {
      role: 'reaper',
      observation: observeEnforcer({
        pid: identity.reaperPid,
        incarnation: identity.reaperIncarnation,
      }),
    },
  ];
  if (observations.some(({ observation }) => observation === 'alive')) {
    return { kind: 'enforcer-alive', observations };
  }
  if (observations.some(({ observation }) => observation === 'unknown')) {
    return { kind: 'enforcer-unobservable', observations };
  }
  signal.throwIfAborted();

  const roots = new Map<string, Readonly<{ pid: number; incarnation: ProcessIncarnation }>>();
  for (const record of operationScan.records) {
    if (
      !('providerRoot' in record) ||
      !providerProxySetIdentitiesEqual(providerProxySetIdentityFromRecord(record), identity)
    ) {
      continue;
    }
    roots.set(`${record.providerRoot.pid}@${record.providerRoot.incarnation}`, record.providerRoot);
  }
  const recordedRoots = [...roots.values()];
  const containment = {
    pid: identity.proxyPid,
    incarnation: identity.proxyIncarnation,
    processGroupId: identity.proxyProcessGroupId,
  };
  const clock = createMonotonicClock(providerSetDisappearanceClockScope);
  await reapRecordedContainment(
    containment,
    recordedRoots,
    clock.shiftMilliseconds(clock.now(), PROXY_TEARDOWN_RESERVE_MS),
    {
      maxRecordedRoots: MAX_PROXY_RECORDED_PROVIDER_ROOTS,
      clock,
      process: runtime.process,
      platform,
      signal,
    },
  );
  signal.throwIfAborted();
  return { kind: 'absent', receipt: providerProxyDisappearanceReceipt(containment, recordedRoots) };
}

export function createProviderProxySetContainmentProver(runtime: Runtime): ProviderProxySetContainmentProver {
  return {
    proveContainmentAbsent: (identity, db, signal) =>
      proveProviderProxySetContainmentAbsent(identity, db, runtime, signal),
  };
}
