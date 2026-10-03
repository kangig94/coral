import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
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

function legacyProxyStartedAtSeconds(pid: number): number | null {
  try {
    if (process.platform === 'linux') {
      const boot = /^btime (\d+)$/m.exec(readFileSync('/proc/stat', 'utf-8'));
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf-8');
      const ticks = stat
        .slice(stat.lastIndexOf(')') + 2)
        .trim()
        .split(/\s+/)[19];
      const frequency = Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf-8', timeout: 2_000 }));
      if (boot === null || ticks === undefined || !/^\d+$/.test(ticks) || !(frequency > 0)) return null;
      return Math.floor(Number(boot[1]) + Number(ticks) / frequency);
    }
    if (process.platform === 'darwin') {
      const raw = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf-8', timeout: 2_000 });
      const startedAt = Date.parse(raw.trim());
      return Number.isFinite(startedAt) ? Math.floor(startedAt / 1_000) : null;
    }
    return null;
  } catch {
    return null;
  }
}

type ControllerBuildObservation = (
  | { kind: 'none' }
  | { kind: 'unknown'; refusalOnly?: boolean; readableBuildSetId?: string }
  | { kind: 'required'; buildSetId: string }
) & {
  refusals?: readonly { path: string; observation: string }[];
};

export function controllerBuild(runDir: string): ControllerBuildObservation {
  const runtime = createRealRuntime(runDir.endsWith('run-dev') ? 'dev' : 'prod', { baseDir: dirname(dirname(runDir)) });
  const refusals: { path: string; observation: string }[] = [];
  let paths: readonly string[] = [];
  try {
    paths = providerHandoffCapsuleCandidatePaths(runDir, runtime.storage);
  } catch (error: unknown) {
    if (!isNoEntryError(error)) refusals.push({ path: runDir, observation: 'capsule-discovery-unreadable' });
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
      refusals.push({ path, observation: 'capsule-unreadable' });
      continue;
    }
    if (candidate.kind !== 'readable') {
      refusals.push({ path, observation: candidate.reason });
      continue;
    }
    readable.push(candidate);
  }
  const superseded = supersededHandoffCapsulePaths(readable);
  let liveEvidenceUnknown = false;
  let custodyUnknown = false;
  const legacyBuilds = new Set<string>();
  const buildsBySet = new Map<string, string>();
  for (const { path, capsule } of readable) {
    if (superseded.has(path)) continue;
    if (capsule.version === 1) continue;
    if (capsule.version === 2) {
      const startedAt = legacyProxyStartedAtSeconds(capsule.proxyPid);
      if (startedAt === capsule.proxyProcessStartedAtSeconds) legacyBuilds.add(capsule.buildSetId);
      else if (startedAt === null && observeProcessLiveness(capsule.proxyPid) !== 'absent')
        refusals.push({ path, observation: 'legacy-proxy-start-time-unobservable' });
      continue;
    }
    const observed = probeProcessIncarnation(capsule.proxyPid);
    if (observed === null) {
      if (observeProcessLiveness(capsule.proxyPid) !== 'absent')
        refusals.push({ path, observation: 'proxy-incarnation-unobservable' });
      continue;
    }
    if (observed === capsule.proxyIncarnation && observeProcessLiveness(capsule.proxyPid) !== 'absent') {
      const transfer = servedControllerTransferForCapsule(runtime, capsule);
      if (transfer.kind === 'unknown') {
        liveEvidenceUnknown = true;
        continue;
      }
      const buildSetId = transfer.kind === 'served' ? transfer.buildSetId : handoffCapsuleControllerBuildSetId(capsule);
      const setKey = providerProxySetKey(providerProxySetIdentityFromCapsule(capsule));
      const existing = buildsBySet.get(setKey);
      if (existing !== undefined && existing !== buildSetId) liveEvidenceUnknown = true;
      buildsBySet.set(setKey, buildSetId);
    }
  }
  const builds = new Set([...legacyBuilds, ...buildsBySet.values()]);
  try {
    const custody = readCustodyLedger(runtime, runDir);
    for (const entry of custody) {
      if (entry.kind === 'unreadable') refusals.push({ path: entry.path, observation: 'custody-record-unreadable' });
    }
    const index = new JobLocationIndex(runtime, runtime.paths.coral.generation.dataRoot);
    const unresolved = new Set(
      index
        .locations()
        .filter((location) => location.disposition !== 'terminal')
        .map((location) => location.jobId),
    );
    const durableCliJob = custody.some(
      (entry) =>
        (entry.kind === 'holding' || entry.kind === 'bound') &&
        entry.intent.owner === 'durable-cli' &&
        unresolved.has(entry.intent.jobId ?? entry.intent.operationId),
    );
    if (durableCliJob) {
      const handoff = prepareRetainedControllerHandoff(runtime, index);
      if (handoff === null) custodyUnknown = true;
      else builds.add(inspectValidatedHandoffTarget(handoff.target).build.buildSetId);
    }
  } catch {
    custodyUnknown = true;
  }
  const refused = refusals.length === 0 ? {} : { refusals };
  if (liveEvidenceUnknown || builds.size > 1) return { kind: 'unknown', ...refused };
  if (custodyUnknown || (builds.size === 0 && refusals.length > 0))
    return {
      kind: 'unknown',
      refusalOnly: refusals.length > 0,
      ...(builds.size === 1 ? { readableBuildSetId: [...builds][0] } : {}),
      ...refused,
    };
  return builds.size === 0 ? { kind: 'none' } : { kind: 'required', buildSetId: [...builds][0], ...refused };
}
