import { type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { closeHandle } from '../infra/ipc-handle.js';
import { type StrictBundleManifest } from '../infra/bundle-manifest.js';
import { currentLaunchStatus } from '../infra/launch-status.js';
import { probeProcessIncarnation } from '../infra/node-process.js';
import { SENTINEL_TIMING, validSentinelTiming, type SentinelTiming } from '../infra/sentinel-timing.js';
import { quarantineCorruptUpgradeIntent, readUpgradeIntent } from '../infra/upgrade-intent.js';
import { type Candidate, type UnidentifiedBinder, selectNextCandidate } from './candidate-selection.js';
import { spawnAdmittedChild } from './child-process.js';
import { superviseActiveChild, superviseAdoptedChild } from './active-child.js';
import { controllerBuild } from './controller-build.js';
import { validatedExecutable } from './executable.js';
import { incumbentLiveness, observedLaunchIncumbent, publishedNativeSupervision } from './incumbent.js';
import { type ReconcileInheritedInput, reconcileInheritedChildren } from './inherited-children.js';
import { type OwnerHandle, acquireLaunchOwnership } from './ownership.js';
import { pendingExecutable, pendingIntent } from './pending-upgrade.js';
import { recordLegacyUpgradeIntent } from './request.js';
import { type SupervisorLaunchMemory, type LaunchReservation } from './state.js';
import { POLL_MS, STARTUP_BUDGET_MS } from './timing.js';

function releaseSettledInheritedLaunch(record: SupervisorLaunchMemory, incarnation: string, runDir: string): boolean {
  const settled = record.read();
  const slots = [settled.launch, settled.attempt];
  return (
    slots.some(
      (slot) => slot !== null && (slot.parent?.pid !== process.pid || slot.parent.incarnation !== incarnation),
    ) &&
    slots.every((slot) => slot === null || slot.phase === 'exited') &&
    slots.some((slot) => slot !== null && record.hasServed(slot.buildSetId)) &&
    pendingIntent(runDir) === null &&
    controllerBuild(runDir).kind === 'none' &&
    record.release()
  );
}

async function superviseSelectedCandidate(input: {
  record: SupervisorLaunchMemory;
  owner: OwnerHandle;
  candidate: Candidate;
  triedCount: number;
  args: readonly string[];
  runDir: string;
  timing: SentinelTiming;
  startupBudgetMs: number;
  onChild?: (child: ChildProcess) => void;
}): Promise<boolean> {
  const { record, owner, candidate, triedCount, args, runDir, timing, startupBudgetMs, onChild } = input;
  if (!record.hasAuthority(owner.current)) return false;
  if (readUpgradeIntent(runDir).kind === 'corrupt') {
    await quarantineCorruptUpgradeIntent(runDir);
    record.reconcileAdmissions();
  }
  const intent = pendingIntent(runDir);
  const purpose =
    intent !== null && pendingExecutable(intent) === candidate.executable
      ? 'legacy-retirement'
      : triedCount === 1
        ? 'startup'
        : 'recovery';
  const reservation = record.reserve(owner.current, candidate.buildSetId, purpose);
  if (reservation === null) {
    await sleep(POLL_MS);
    return false;
  }
  const initial = spawnAdmittedChild(record, owner.current, reservation, candidate.executable, args, runDir);
  if (initial === null) {
    await sleep(POLL_MS);
    return false;
  }
  return superviseActiveChild({ record, owner, initial, reservation, runDir, timing, startupBudgetMs, onChild });
}

async function selectAndSuperviseCandidate(input: {
  record: SupervisorLaunchMemory;
  owner: OwnerHandle;
  runDir: string;
  original: Candidate;
  originalManifest: StrictBundleManifest;
  tried: Set<string>;
  firstLaunch: boolean;
  unidentifiedBinder: UnidentifiedBinder;
  args: readonly string[];
  timing: SentinelTiming;
  startupBudgetMs: number;
  onChild?: (child: ChildProcess) => void;
}): Promise<{ released: boolean; firstLaunch: boolean }> {
  const {
    record,
    owner,
    runDir,
    original,
    originalManifest,
    tried,
    firstLaunch,
    unidentifiedBinder,
    args,
    timing,
    startupBudgetMs,
    onChild,
  } = input;
  const authority = owner.current;
  const selection = await selectNextCandidate({
    record,
    owner,
    runDir,
    original,
    originalManifest,
    tried,
    firstLaunch,
    unidentifiedBinder,
  });
  if (!record.hasAuthority(authority)) return { released: false, firstLaunch };
  if (selection.kind === 'released') return { released: true, firstLaunch };
  if (selection.kind === 'retry') return { released: false, firstLaunch };
  const candidate = selection.candidate;
  record.clearHold();
  tried.add(candidate.executable);
  const released = await superviseSelectedCandidate({
    record,
    owner,
    candidate,
    triedCount: tried.size,
    args,
    runDir,
    timing,
    startupBudgetMs,
    onChild,
  });
  return { released, firstLaunch: false };
}

type NamespaceSupervision = ReconcileInheritedInput & {
  original: Candidate;
  tried: Set<string>;
  firstLaunch: boolean;
  unidentifiedBinder: UnidentifiedBinder;
  args: readonly string[];
  onChild?: (child: ChildProcess) => void;
};

function isRecoverySourceParent(): boolean {
  return (
    process.ppid === Number(process.env.CORAL_RECOVERY_SOURCE_PID) &&
    probeProcessIncarnation(process.ppid) === process.env.CORAL_RECOVERY_SOURCE_INCARNATION
  );
}

function answerRecoveryChallenge(session: NamespaceSupervision, message: unknown, handle: unknown): void {
  const { replacement, owner, record, recoveryChallenge } = session;
  if (
    typeof message === 'object' &&
    message !== null &&
    'kind' in message &&
    message.kind === 'coral-recovery-challenge'
  )
    closeHandle(handle);
  if (
    !replacement ||
    owner.lost ||
    !record.hasAuthority(owner.current) ||
    !isRecoverySourceParent() ||
    typeof message !== 'object' ||
    message === null ||
    !('kind' in message) ||
    message.kind !== 'coral-recovery-challenge' ||
    !('challenge' in message) ||
    message.challenge !== recoveryChallenge ||
    !('id' in message) ||
    !Number.isSafeInteger(message.id)
  )
    return;
  process.send?.({
    kind: 'coral-recovery-answer',
    challenge: recoveryChallenge,
    id: message.id,
    normalized: record.read().owner.mode === 'supervised',
  });
}

async function awaitOwnedChildrenAfterAuthorityLoss(
  record: SupervisorLaunchMemory,
): Promise<Readonly<{ kind: 'owned-children-absent' }>> {
  while (true) {
    let ownedChildMayLive = false;
    for (const slot of [record.read().launch, record.read().attempt]) {
      if (slot?.parent?.pid !== process.pid || slot.child === undefined) continue;
      const liveness = incumbentLiveness(slot.child);
      if (liveness === 'alive' || liveness === 'unknown') ownedChildMayLive = true;
    }
    if (!ownedChildMayLive) return { kind: 'owned-children-absent' };
    await sleep(POLL_MS);
  }
}

async function releaseToInheritedSupervision(
  session: NamespaceSupervision,
  inherited: readonly LaunchReservation[],
): Promise<boolean> {
  const { record, runDir, originalManifest, original, replacement, repairBridge } = session;
  const executable = original.executable;
  const observedInherited = record.read().launch;
  if (
    observedInherited !== null &&
    observedInherited.phase === 'serving' &&
    observedInherited.observedHealthyAt !== undefined &&
    observedInherited.parent?.pid !== process.pid &&
    observedInherited.child?.pid !== process.ppid &&
    repairBridge === null &&
    publishedNativeSupervision(runDir, observedInherited)
  ) {
    const incumbent = observedLaunchIncumbent(runDir, originalManifest.flavor);
    if (incumbent !== null)
      await recordLegacyUpgradeIntent({
        runDir,
        requestId: randomUUID(),
        incumbent,
        target: { build: originalManifest, pluginRootLabel: dirname(dirname(executable)) },
      });
    return true;
  }
  if (
    replacement &&
    inherited.length === 1 &&
    inherited[0].phase === 'serving' &&
    inherited[0].child?.pid !== process.ppid &&
    repairBridge === null &&
    pendingIntent(runDir) !== null
  )
    return true;
  return false;
}

async function superviseInheritedLaunch(
  session: NamespaceSupervision,
  inherited: readonly LaunchReservation[],
): Promise<'released' | 'retry' | 'vacant'> {
  const { record, owner, runDir, incarnation, repairBridge, lastInheritedRequest } = session;
  record.normalize();
  const adoptedChild = repairBridge?.child(record.read().launch?.id);
  if (adoptedChild !== null && adoptedChild !== undefined && repairBridge !== null) {
    const released = await superviseAdoptedChild({
      record,
      owner,
      runDir,
      repairBridge,
      adoptedChild,
      lastInheritedRequest,
    });
    session.repairBridge = null;
    return released ? 'released' : 'retry';
  }
  if (releaseSettledInheritedLaunch(record, incarnation, runDir)) return 'released';
  if (inherited.length > 0) {
    await sleep(POLL_MS);
    return 'retry';
  }
  return 'vacant';
}

async function superviseNamespace(session: NamespaceSupervision): Promise<number> {
  const { record, owner, runDir } = session;
  while (true) {
    if (owner.lost) {
      session.repairBridge?.close();
      session.repairBridge = null;
      await awaitOwnedChildrenAfterAuthorityLoss(record);
      return 1;
    }
    record.reconcileAdmissions();
    if (process.connected)
      process.send?.({ kind: 'coral-launch-status', status: currentLaunchStatus(runDir) }, () => undefined);
    const reconciled = await reconcileInheritedChildren(session);
    const { inherited } = reconciled;
    session.repairBridge = reconciled.repairBridge;
    if (owner.lost || !record.hasAuthority(owner.current)) {
      owner.lost = true;
      session.repairBridge?.close();
      session.repairBridge = null;
      continue;
    }
    if (await releaseToInheritedSupervision(session, inherited)) return 0;
    const inheritedDisposition = await superviseInheritedLaunch(session, inherited);
    if (inheritedDisposition === 'released') return 0;
    if (inheritedDisposition === 'retry') continue;
    const selection = await selectAndSuperviseCandidate(session);
    session.firstLaunch = selection.firstLaunch;
    if (selection.released) return 0;
  }
}

export async function runNamespaceSupervisor(
  executable: string,
  args: readonly string[],
  runDir: string,
  options: Readonly<{
    timing?: SentinelTiming;
    startupBudgetMs?: number;
    onChild?: (child: ChildProcess) => void;
  }> = {},
): Promise<number> {
  const timing = options.timing ?? SENTINEL_TIMING;
  if (!validSentinelTiming(timing)) throw new Error('Invalid coordinator supervisor timing');
  const startupBudgetMs = options.startupBudgetMs ?? STARTUP_BUDGET_MS;
  const originalManifest = validatedExecutable(executable);
  if (originalManifest === null) return 1;
  const acquisition = await acquireLaunchOwnership(runDir, executable, originalManifest);
  if (acquisition.kind === 'finished') return acquisition.exitCode;
  const session: NamespaceSupervision = {
    ...acquisition,
    runDir,
    originalManifest,
    timing,
    startupBudgetMs,
    args,
    onChild: options.onChild,
    original: { executable, buildSetId: originalManifest.buildSetId },
    tried: new Set<string>(),
    lastInheritedRequest: new Map<string, number>(),
    repairBridge: null,
    firstLaunch: true,
    unidentifiedBinder: { observed: false },
  };
  const onRecoveryChallenge = (message: unknown, handle: unknown): void =>
    answerRecoveryChallenge(session, message, handle);
  if (acquisition.replacement) process.on('message', onRecoveryChallenge);
  try {
    return await superviseNamespace(session);
  } finally {
    process.off('message', onRecoveryChallenge);
    acquisition.owner.release();
  }
}
