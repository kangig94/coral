import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { recordControllerEvidenceRefusals } from '../infra/launch-status.js';
import { type StrictBundleManifest } from '../infra/bundle-manifest.js';
import { compareProductVersions } from '../infra/product-version.js';
import { validatedRunningBuildRoot } from '../infra/retained-build-root.js';
import { readUpgradeIntent } from '../infra/upgrade-intent.js';
import { createRealRuntime } from '../runtime/real.js';
import { readCustodyLedger } from '../store/custody-ledger.js';
import { controllerBuild } from './controller-build.js';
import { targetValidation, validatedExecutable } from './executable.js';
import { incumbentAt, incumbentLiveness, observedLaunchIncumbent, socketClaimedBeforeDiscovery } from './incumbent.js';
import { type OwnerHandle } from './ownership.js';
import { closeUnavailableLegacyRequest, pendingExecutable, pendingIntent } from './pending-upgrade.js';
import { recordLegacyUpgradeIntent } from './request.js';
import { relaunchRoots, validatedBuild } from './selection.js';
import { type SupervisorLaunchMemory } from './state.js';
import { POLL_MS } from './timing.js';

export type Candidate = Readonly<{ executable: string; buildSetId: string }>;

function completedServingIntent(runDir: string) {
  const observed = readUpgradeIntent(runDir);
  return observed.kind === 'readable' &&
    observed.intent.disposition === 'completed' &&
    observed.intent.completionReceipt?.kind === 'serving' &&
    observed.intent.completionReceipt.successor.build.buildSetId === observed.intent.target.build.buildSetId
    ? observed.intent
    : null;
}

function candidates(
  runDir: string,
  original: Candidate,
  originalManifest: StrictBundleManifest,
  originalOutstanding: boolean,
  controller: ReturnType<typeof controllerBuild>,
  refusalGraceExpired: boolean,
): Candidate[] {
  if (controller.kind === 'unknown') return [];
  const committedIntent = completedServingIntent(runDir);
  const committedRoot =
    committedIntent === null
      ? null
      : validatedRunningBuildRoot(runDir, committedIntent.target.pluginRootLabel, committedIntent.target.build);
  const committed =
    committedRoot === null || committedIntent === null
      ? null
      : {
          executable: join(committedRoot, 'bridge', 'coral-backend.cjs'),
          buildSetId: committedIntent.target.build.buildSetId,
        };
  const pending = pendingIntent(runDir);
  const requested =
    pending !== null && validatedExecutable(pendingExecutable(pending))?.buildSetId === pending.target.build.buildSetId
      ? [{ executable: pendingExecutable(pending), buildSetId: pending.target.build.buildSetId }]
      : [];
  const originalRoot = validatedRunningBuildRoot(runDir, dirname(dirname(original.executable)), originalManifest);
  const recovery = relaunchRoots(runDir, originalManifest).flatMap((root) => {
    const build = validatedBuild(root);
    return build === null
      ? []
      : [{ executable: join(root, 'bridge', 'coral-backend.cjs'), buildSetId: build.buildSetId }];
  });
  const requiredBuild = controller.kind === 'required' ? controller.buildSetId : (committed?.buildSetId ?? null);
  if (refusalGraceExpired && requiredBuild === null)
    return validatedExecutable(original.executable)?.buildSetId === original.buildSetId ? [original] : [];
  const retainedController =
    requiredBuild === null ? null : validatedBuild(join(dirname(runDir), 'builds', requiredBuild));
  const controllerCandidate =
    retainedController !== null &&
    retainedController.buildSetId === requiredBuild &&
    retainedController.flavor === originalManifest.flavor
      ? [
          {
            executable: join(dirname(runDir), 'builds', requiredBuild, 'bridge', 'coral-backend.cjs'),
            buildSetId: requiredBuild,
          },
        ]
      : [];
  const choices = [
    ...new Map(
      [
        ...requested,
        ...(committed === null ? [] : [committed]),
        ...controllerCandidate,
        ...recovery,
        ...(originalOutstanding ? [original] : []),
        ...(originalRoot === null
          ? []
          : [{ executable: join(originalRoot, 'bridge', 'coral-backend.cjs'), buildSetId: original.buildSetId }]),
      ].map((candidate) => [candidate.executable, candidate]),
    ).values(),
  ];
  const eligible =
    controller.kind === 'required'
      ? choices.filter((candidate) => candidate.buildSetId === controller.buildSetId)
      : choices;
  return eligible.sort((a, b) => {
    const left = validatedExecutable(a.executable);
    const right = validatedExecutable(b.executable);
    if (left === null || right === null) return 0;
    return compareProductVersions(right.version, left.version);
  });
}

const CONTROLLER_EVIDENCE_GRACE_MS = 2_000;
const evidenceHoldStartedAt = new WeakMap<SupervisorLaunchMemory, number>();

export type UnidentifiedBinder = { observed: boolean };

export async function selectNextCandidate(input: {
  record: SupervisorLaunchMemory;
  owner: OwnerHandle;
  runDir: string;
  original: Candidate;
  originalManifest: StrictBundleManifest;
  tried: Set<string>;
  firstLaunch: boolean;
  unidentifiedBinder: UnidentifiedBinder;
}): Promise<{ kind: 'released' } | { kind: 'retry' } | { kind: 'candidate'; candidate: Candidate }> {
  const { record, owner, runDir, original, originalManifest, tried, firstLaunch, unidentifiedBinder } = input;
  let requested = pendingIntent(runDir);
  if (incumbentAt(runDir) === null && (await socketClaimedBeforeDiscovery(runDir, originalManifest.flavor))) {
    unidentifiedBinder.observed = true;
    await sleep(POLL_MS);
    return { kind: 'retry' };
  }
  if (unidentifiedBinder.observed) {
    unidentifiedBinder.observed = false;
    const identified = observedLaunchIncumbent(runDir, originalManifest.flavor);
    if (requested === null && identified !== null && identified.pid !== process.pid) {
      await recordLegacyUpgradeIntent({
        runDir,
        requestId: randomUUID(),
        incumbent: identified,
        target: { build: originalManifest, pluginRootLabel: dirname(dirname(original.executable)) },
      });
      requested = pendingIntent(runDir);
    }
  }
  if (requested !== null && targetValidation(pendingExecutable(requested)) === 'absent')
    await closeUnavailableLegacyRequest(runDir, requested.requestId);
  const recordedIncumbents = requested === null ? [] : [requested.incumbent];
  let incumbentHeld = false;
  for (const recorded of recordedIncumbents) {
    if (recorded.pid === process.pid) continue;
    const liveness = incumbentLiveness(recorded);
    if (liveness === 'alive' || liveness === 'unknown') incumbentHeld = true;
  }
  if (incumbentHeld) {
    await sleep(POLL_MS);
    return { kind: 'retry' };
  }
  const incumbent = incumbentAt(runDir);
  if (
    !firstLaunch &&
    incumbent !== null &&
    incumbent.pid !== process.pid &&
    incumbentLiveness(incumbent) !== 'absent'
  ) {
    await sleep(POLL_MS);
    return { kind: 'retry' };
  }
  let controller = controllerBuild(runDir);
  let refusalGraceExpired = false;
  recordControllerEvidenceRefusals(
    runDir,
    (controller.refusals ?? []).map((entry) => ({ ...entry, observedAt: new Date().toISOString() })),
  );
  if (controller.kind === 'unknown' && controller.refusalOnly) {
    const now = Number(process.hrtime.bigint() / 1_000_000n);
    const startedAt = evidenceHoldStartedAt.get(record) ?? now;
    evidenceHoldStartedAt.set(record, startedAt);
    if (now - startedAt >= CONTROLLER_EVIDENCE_GRACE_MS) {
      refusalGraceExpired = true;
      controller =
        controller.readableBuildSetId === undefined
          ? { kind: 'none', refusals: controller.refusals }
          : { kind: 'required', buildSetId: controller.readableBuildSetId, refusals: controller.refusals };
    }
  } else {
    evidenceHoldStartedAt.delete(record);
  }
  if (refusalGraceExpired && controller.kind === 'none') {
    const committed = completedServingIntent(runDir);
    if (committed !== null)
      controller = { kind: 'required', buildSetId: committed.target.build.buildSetId, refusals: controller.refusals };
  }
  const eligible = candidates(
    runDir,
    original,
    originalManifest,
    !record.hasServed(original.buildSetId),
    controller,
    refusalGraceExpired,
  );
  const available = eligible.filter((candidate) => !tried.has(candidate.executable));
  if (available.length === 0) {
    const state = record.read();
    if (
      eligible.length === 0 &&
      controller.kind === 'none' &&
      (requested === null || targetValidation(pendingExecutable(requested)) === 'absent') &&
      [state.launch, state.attempt].every((slot) => slot === null || slot.phase === 'exited') &&
      record.release()
    )
      return { kind: 'released' };
    const unreadable = readCustodyLedger(
      createRealRuntime(runDir.endsWith('run-dev') ? 'dev' : 'prod', {
        baseDir: dirname(dirname(runDir)),
      }),
      runDir,
    ).find((entry) => entry.kind === 'unreadable');
    if (controller.kind === 'unknown' && controller.refusalOnly && unreadable?.kind === 'unreadable') {
      if (!record.holdUnreadableCustody(owner.current, unreadable.path)) return { kind: 'retry' };
    } else {
      if (
        !record.hold(
          owner.current,
          controller.kind === 'required' ? controller.buildSetId : controller.kind,
          controller.kind === 'unknown' && !!controller.refusalOnly,
        )
      )
        return { kind: 'retry' };
    }
    tried.clear();
    await sleep(2_000);
    return { kind: 'retry' };
  }
  return { kind: 'candidate', candidate: available[0] };
}
