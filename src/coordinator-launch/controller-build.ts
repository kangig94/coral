import { dirname } from 'node:path';

import {
  providerProxySetIdentityFromCapsule,
  providerProxySetKey,
} from '../coordinator/services/provider-proxy-set/identity.js';
import { prepareRetainedControllerHandoff } from '../coordinator/services/startup-retirement.js';
import { servedControllerTransferForCapsule } from '../coordinator/succession/provider-host-transfer.js';
import { isNoEntryError } from '../infra/fs-errors.js';
import { inspectValidatedHandoffTarget } from '../infra/handoff-target.js';
import { observeProcessLiveness, probeProcessIncarnation } from '../infra/node-process.js';
import { JobLocationIndex } from '../jobs/location-index.js';
import {
  providerHandoffCapsuleCandidatePaths,
  readProviderHandoffCapsuleCandidate,
  supersededHandoffCapsulePaths,
} from '../provider-proxy/handoff-capsule-discovery.js';
import { handoffCapsuleControllerBuildSetId, type HandoffCapsule } from '../provider-proxy/handoff-capsule.js';
import { createRealRuntime } from '../runtime/real.js';
import { readCustodyLedger } from '../store/custody-ledger.js';

export function controllerBuild(
  runDir: string,
): { kind: 'none' | 'unknown' } | { kind: 'required'; buildSetId: string } {
  const runtime = createRealRuntime(runDir.endsWith('run-dev') ? 'dev' : 'prod', { baseDir: dirname(dirname(runDir)) });
  let paths: readonly string[];
  try {
    paths = providerHandoffCapsuleCandidatePaths(runDir, runtime.storage);
  } catch (error: unknown) {
    return isNoEntryError(error) ? { kind: 'none' } : { kind: 'unknown' };
  }
  const readable: { path: string; capsule: HandoffCapsule }[] = [];
  for (const path of paths) {
    let candidate: ReturnType<typeof readProviderHandoffCapsuleCandidate>;
    try {
      candidate = readProviderHandoffCapsuleCandidate(path, runtime.paths.coral.generation.root, {
        storage: runtime.storage,
        uid: process.getuid?.() ?? 0,
      });
    } catch {
      return { kind: 'unknown' };
    }
    if (candidate.kind !== 'readable') return { kind: 'unknown' };
    readable.push(candidate);
  }
  const superseded = supersededHandoffCapsulePaths(readable);
  const buildsBySet = new Map<string, string>();
  for (const { path, capsule } of readable) {
    if (superseded.has(path)) continue;
    if (capsule.version === 1) continue;
    if (capsule.version === 2) {
      if (observeProcessLiveness(capsule.proxyPid) !== 'absent') return { kind: 'unknown' };
      continue;
    }
    const observed = probeProcessIncarnation(capsule.proxyPid);
    if (observed === null) {
      if (observeProcessLiveness(capsule.proxyPid) !== 'absent') return { kind: 'unknown' };
      continue;
    }
    if (observed === capsule.proxyIncarnation && observeProcessLiveness(capsule.proxyPid) !== 'absent') {
      const transfer = servedControllerTransferForCapsule(runtime, capsule);
      if (transfer.kind === 'unknown') return { kind: 'unknown' };
      const buildSetId = transfer.kind === 'served' ? transfer.buildSetId : handoffCapsuleControllerBuildSetId(capsule);
      const setKey = providerProxySetKey(providerProxySetIdentityFromCapsule(capsule));
      const existing = buildsBySet.get(setKey);
      if (existing !== undefined && existing !== buildSetId) return { kind: 'unknown' };
      buildsBySet.set(setKey, buildSetId);
    }
  }
  const builds = new Set(buildsBySet.values());
  try {
    const index = new JobLocationIndex(runtime, runtime.paths.coral.generation.dataRoot);
    const unresolved = new Set(
      index
        .locations()
        .filter((location) => location.disposition !== 'terminal')
        .map((location) => location.jobId),
    );
    const custody = readCustodyLedger(runtime, runDir);
    if (custody.some((entry) => entry.kind === 'unreadable')) return { kind: 'unknown' };
    const durableCliJob = custody.some(
      (entry) =>
        (entry.kind === 'holding' || entry.kind === 'bound') &&
        entry.intent.owner === 'durable-cli' &&
        unresolved.has(entry.intent.jobId ?? entry.intent.operationId),
    );
    if (durableCliJob) {
      const handoff = prepareRetainedControllerHandoff(runtime, index);
      if (handoff === null) return { kind: 'unknown' };
      builds.add(inspectValidatedHandoffTarget(handoff.target).build.buildSetId);
    }
  } catch {
    return { kind: 'unknown' };
  }
  if (builds.size === 0) return { kind: 'none' };
  return builds.size === 1 ? { kind: 'required', buildSetId: [...builds][0] } : { kind: 'unknown' };
}
