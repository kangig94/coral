import { type StrictBundleManifest } from '../infra/bundle-manifest.js';
import { probeProcessIncarnation } from '../infra/node-process.js';
import { compareProductVersions } from '../infra/product-version.js';
import { type SentinelTiming } from '../infra/sentinel-timing.js';
import { signalInheritedChild } from './child-process.js';
import { childHasExited, childIsUninterruptible } from './child-state.js';
import { validatedExecutable } from './executable.js';
import { replacementServing, requestInheritedSuccession } from './health.js';
import { incumbentLiveness } from './incumbent.js';
import { type OwnerHandle } from './ownership.js';
import { pendingExecutable, pendingIntent } from './pending-upgrade.js';
import { createRepairBridge } from './repair-bridge.js';
import { installedBuild } from '../infra/installed-build-root.js';
import { type SupervisorLaunchMemory, type LaunchProcess, type LaunchReservation } from './state.js';

export type ReconcileInheritedInput = {
  record: SupervisorLaunchMemory;
  owner: OwnerHandle;
  runDir: string;
  originalManifest: StrictBundleManifest;
  timing: SentinelTiming;
  startupBudgetMs: number;
  lastInheritedRequest: Map<string, number>;
  repairBridge: ReturnType<typeof createRepairBridge> | null;
  replacement: boolean;
  recoveryChallenge: string | undefined;
  incarnation: NonNullable<ReturnType<typeof probeProcessIncarnation>>;
};

async function reconcileInheritedChild(
  input: ReconcileInheritedInput,
  snapshot: LaunchReservation,
  repairBridge: ReturnType<typeof createRepairBridge> | null,
  currentInheritedChild: (snapshot: LaunchReservation, child: LaunchProcess) => LaunchReservation | null,
): Promise<ReturnType<typeof createRepairBridge> | null> {
  const {
    record,
    owner,
    runDir,
    originalManifest,
    timing,
    startupBudgetMs,
    lastInheritedRequest,
    replacement,
    recoveryChallenge,
  } = input;
  const inheritedWatch = record.inheritedWatch;
  let slot = snapshot;
  const child = slot.child;
  if (child === undefined || currentInheritedChild(snapshot, child) === null) return repairBridge;
  if (incumbentLiveness(child) === 'absent' || childHasExited(child.pid)) {
    record.settleAbsentChild(slot);
    inheritedWatch.delete(slot.id);
    return repairBridge;
  }
  let now = Number(process.hrtime.bigint() / 1_000_000n);
  const watch = inheritedWatch.get(slot.id) ?? {
    firstSeen: now,
    lastHealthy: now - Math.max(0, Date.now() - (slot.observedHealthyAt ?? slot.admittedAt ?? Date.now())),
    uninterruptibleSince: null,
    terminationAt: slot.terminationAt ?? null,
  };
  inheritedWatch.set(slot.id, watch);
  const health =
    probeProcessIncarnation(child.pid) === child.incarnation
      ? await replacementServing(runDir, originalManifest.flavor, child.pid)
      : 'unknown';
  if (health === 'unknown') return repairBridge;
  const healthy = health === true;
  const current = currentInheritedChild(snapshot, child);
  if (current === null) {
    return repairBridge;
  }
  slot = current;
  watch.terminationAt = slot.terminationAt ?? watch.terminationAt;
  now = Number(process.hrtime.bigint() / 1_000_000n);
  if (healthy) {
    record.observeInheritedHealth(slot, Date.now());
    slot = currentInheritedChild(snapshot, child) ?? slot;
    watch.terminationAt = slot.terminationAt ?? null;
  }
  if (healthy && watch.terminationAt === null) {
    watch.lastHealthy = now;
    watch.uninterruptibleSince = null;
    inheritedWatch.set(slot.id, watch);
    if (process.connected && process.ppid === child.pid && probeProcessIncarnation(child.pid) === child.incarnation) {
      if (repairBridge === null) {
        repairBridge = createRepairBridge(record, owner, runDir, timing, startupBudgetMs);
        if (replacement) process.send?.({ kind: 'coral-repair-bridge-ready', challenge: recoveryChallenge });
      }
    }
    const incumbentManifest =
      slot.buildSetId === originalManifest.buildSetId
        ? originalManifest
        : (installedBuild(slot.buildSetId)?.manifest ?? null);
    const intent = pendingIntent(runDir);
    if (
      repairBridge !== null &&
      incumbentManifest !== null &&
      intent !== null &&
      (record.read().attempt === null || record.read().attempt?.phase === 'exited') &&
      intent.target.build.buildSetId !== slot.buildSetId &&
      now - (lastInheritedRequest.get(intent.requestId) ?? 0) >= 10_000
    ) {
      const target = validatedExecutable(pendingExecutable(intent));
      if (target !== null && compareProductVersions(target.version, incumbentManifest.version) > 0) {
        lastInheritedRequest.set(intent.requestId, now);
        await requestInheritedSuccession(
          runDir,
          incumbentManifest.flavor,
          child.pid,
          intent.requestId,
          intent.target,
          () => currentInheritedChild(snapshot, child) !== null,
        );
      }
    }
  }
  const live = currentInheritedChild(snapshot, child);
  if (live === null) {
    return repairBridge;
  }
  slot = live;
  watch.terminationAt = slot.terminationAt ?? watch.terminationAt;
  now = Number(process.hrtime.bigint() / 1_000_000n);
  const overdue =
    (slot.phase === 'admitted' &&
      slot.admittedAt !== undefined &&
      (slot.admittedMonotonicMs === undefined
        ? Date.now() >= Math.min(slot.admittedAt + startupBudgetMs, slot.attemptDeadline ?? Infinity)
        : Number(process.hrtime.bigint() / 1_000_000n) - slot.admittedMonotonicMs >=
          Math.min(startupBudgetMs, (slot.attemptDeadline ?? Infinity) - slot.admittedAt))) ||
    (slot.phase === 'serving' && now - watch.lastHealthy >= timing.lapseMs);
  if (!overdue && watch.terminationAt === null) return repairBridge;
  if (watch.terminationAt !== null) {
    if (slot.termDelivered !== true) {
      if (!signalInheritedChild(record, owner.current, slot, 'SIGTERM')) record.holdInheritedChild(owner.current, slot);
      return repairBridge;
    }
    if (
      record.terminationGraceElapsed(slot) &&
      record.commitTermination(owner.current, slot, child, Date.now(), timing.graceMs) &&
      !signalInheritedChild(record, owner.current, slot, 'SIGKILL')
    ) {
      if (!record.holdInheritedChild(owner.current, slot)) inheritedWatch.delete(slot.id);
    }
    return repairBridge;
  }
  if (childIsUninterruptible(child.pid)) {
    watch.uninterruptibleSince ??= now;
    if (now - watch.uninterruptibleSince < timing.dStateDeferralMs) return repairBridge;
  } else {
    watch.uninterruptibleSince = null;
  }
  if (record.commitTermination(owner.current, slot, child, Date.now(), timing.graceMs)) {
    watch.terminationAt = now;
    if (!signalInheritedChild(record, owner.current, slot, 'SIGTERM')) {
      if (!record.holdInheritedChild(owner.current, slot)) inheritedWatch.delete(slot.id);
    }
  } else if (!record.holdInheritedChild(owner.current, slot)) inheritedWatch.delete(slot.id);
  return repairBridge;
}

export async function reconcileInheritedChildren(
  input: ReconcileInheritedInput,
): Promise<Readonly<{ inherited: LaunchReservation[]; repairBridge: ReturnType<typeof createRepairBridge> | null }>> {
  const { record, owner, incarnation } = input;
  const authority = owner.current;
  let repairBridge = input.repairBridge;
  const inherited = record
    .children()
    .filter(
      (slot): slot is LaunchReservation =>
        slot !== null &&
        (slot.phase === 'admitted' || slot.phase === 'serving') &&
        record.supervisionEligible(slot) &&
        (slot.parent?.pid !== process.pid || slot.parent.incarnation !== incarnation),
    );
  const currentInheritedChild = (snapshot: LaunchReservation, child: LaunchProcess): LaunchReservation | null => {
    const current = record.currentChild(snapshot, child);
    return !owner.lost &&
      record.hasAuthority(authority) &&
      current !== undefined &&
      current !== null &&
      record.supervisionEligible(current) &&
      (current.phase === 'admitted' || current.phase === 'serving') &&
      current.child?.pid === child.pid &&
      current.child.incarnation === child.incarnation
      ? current
      : null;
  };
  if (inherited.length > 0) {
    for (const snapshot of inherited) {
      repairBridge = await reconcileInheritedChild(input, snapshot, repairBridge, currentInheritedChild);
    }
  }
  return { inherited, repairBridge };
}
