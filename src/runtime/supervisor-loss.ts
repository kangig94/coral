import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { StrictBundleManifest } from '../infra/bundle-manifest.js';
import { readDiscoveryRecordDisposition } from '../infra/backend-discovery.js';
import { receiveLaunchStatus, updateLaunchStatus } from '../infra/launch-status.js';
import { readUpgradeIntent } from '../infra/upgrade-intent.js';
import { probeProcessIncarnation, type ProcessIncarnation } from '../infra/node-process.js';
import { SENTINEL_TIMING } from '../infra/sentinel-timing.js';
import { attemptExclusiveFileLockSync } from '../infra/fs-lock.js';
import { supervisorLockPath } from '../infra/path/index.js';
import { validatedRunningBuildRoot } from '../infra/retained-build-root.js';
import { createRealRuntime } from './real.js';
import { installReplacementSupervisorChannel } from './succession-attempt.js';

const RETRY_MS = 1_000;
const ACCEPTANCE_DEADLINE_MS = 10_000;

type ReplacementSupervisorControl = {
  pluginRoot: string;
  runDir: string;
  manifest: StrictBundleManifest;
  onError: (error: Error) => void;
  onAccepted: (pluginRoot: string) => Promise<void>;
  env: NodeJS.ProcessEnv;
  failing: boolean;
};

type ReplacementSupervisorAttempt = {
  control: ReplacementSupervisorControl;
  root: string;
  sourceIncarnation: ProcessIncarnation;
  challenge: string;
  supervisor: ChildProcess;
  settled: boolean;
  accepted: boolean;
  bridgeReady: boolean;
  repairStarted: boolean;
  lastAnswer: number;
  lastWake: number;
  sequence: number;
  outstanding: number | null;
  launchedIncarnation: ProcessIncarnation | null;
  holdId: string;
  retirementAt: number | null;
  termDeliveredAt: number | null;
  killSent: boolean;
  retirementPoll: ReturnType<typeof setInterval>;
  deadline: ReturnType<typeof setTimeout>;
};

function retryReplacementSupervisor(control: ReplacementSupervisorControl, error: Error): void {
  if (!control.failing) control.onError(error);
  control.failing = true;
  setTimeout(() => {
    const path = supervisorLockPath(control.runDir);
    if (existsSync(path)) {
      const lock = attemptExclusiveFileLockSync(path);
      if (lock.kind !== 'acquired') {
        retryReplacementSupervisor(control, error);
        return;
      }
      lock.lease();
    }
    launchReplacementSupervisor(control);
  }, RETRY_MS);
}

function sourceIdentityHold(attempt: ReplacementSupervisorAttempt, held: boolean): void {
  const path = join(attempt.control.runDir, 'coordinator.json');
  updateLaunchStatus(attempt.control.runDir, (status) => ({
    ...status,
    admissionHolds: [
      ...(status.admissionHolds ?? []).filter((hold) => hold.path !== path),
      ...(held ? [{ path, disposition: 'unknown' as const }] : []),
    ],
  }));
}

function repairReplacementSupervisor(attempt: ReplacementSupervisorAttempt): void {
  const { control, root } = attempt;
  if (attempt.settled) return;
  if (attempt.retirementAt !== null) {
    attempt.repairStarted = false;
    return;
  }
  const retry = (): void => {
    setTimeout(() => {
      if (attempt.settled) return;
      if (attempt.retirementAt !== null) {
        attempt.repairStarted = false;
        return;
      }
      const observed = readUpgradeIntent(control.runDir);
      const completed =
        observed.kind === 'readable' &&
        observed.intent.disposition === 'completed' &&
        observed.intent.incumbent.pid === process.pid &&
        observed.intent.incumbent.incarnation === attempt.sourceIncarnation;
      const source = probeProcessIncarnation(process.pid);
      const discovery = servingSourceDisposition(control, attempt.sourceIncarnation);
      const unknown = source === null || discovery === 'unknown';
      const settled =
        completed || (source !== null && source !== attempt.sourceIncarnation) || discovery === 'superseded';
      sourceIdentityHold(attempt, unknown && !settled);
      if (settled) return;
      if (source === null) retry();
      else repairReplacementSupervisor(attempt);
    }, RETRY_MS);
  };
  void control
    .onAccepted(root)
    .then(retry)
    .catch((error: unknown) => {
      control.onError(error instanceof Error ? error : new Error(String(error)));
      retry();
    });
}

function finishReplacementAttempt(attempt: ReplacementSupervisorAttempt, error: Error | null): void {
  if (attempt.settled) return;
  attempt.settled = true;
  sourceIdentityHold(attempt, false);
  clearInterval(attempt.retirementPoll);
  clearTimeout(attempt.deadline);
  attempt.supervisor.unref();
  if (error !== null) retryReplacementSupervisor(attempt.control, error);
}

function replacementHold(attempt: ReplacementSupervisorAttempt, held: boolean): void {
  const pid = attempt.supervisor.pid;
  const incarnation = attempt.launchedIncarnation ?? 'unavailable';
  if (pid === undefined) return;
  const launchId = attempt.holdId;
  try {
    updateLaunchStatus(attempt.control.runDir, (status) => ({
      ...status,
      signalHolds: held
        ? [
            ...status.signalHolds.filter((entry) => entry.launchId !== launchId),
            { launchId, pid, incarnation, observation: probeProcessIncarnation(pid) ?? 'unknown' },
          ]
        : status.signalHolds.filter((entry) => entry.launchId !== launchId),
    }));
  } catch (error: unknown) {
    attempt.control.onError(new Error(`Replacement supervisor signal status could not be written: ${String(error)}`));
  }
}

function pollReplacementRetirement(attempt: ReplacementSupervisorAttempt): void {
  const { supervisor } = attempt;
  if (attempt.settled || supervisor.pid === undefined || attempt.killSent) return;
  if (supervisor.exitCode !== null || supervisor.signalCode !== null) return;
  const now = performance.now();
  const gap = now - attempt.lastWake;
  attempt.lastWake = now;
  if (attempt.accepted && gap > SENTINEL_TIMING.schedulingGapMs) {
    attempt.lastAnswer = now;
    attempt.outstanding = null;
  }
  const observed = probeProcessIncarnation(supervisor.pid);
  if (attempt.accepted && attempt.retirementAt === null) {
    if (now - attempt.lastAnswer >= SENTINEL_TIMING.lapseMs) attempt.retirementAt = now;
    else if (supervisor.connected && attempt.outstanding === null) {
      attempt.outstanding = ++attempt.sequence;
      supervisor.send(
        { kind: 'coral-recovery-challenge', challenge: attempt.challenge, id: attempt.outstanding },
        () => undefined,
      );
    }
  }
  if (attempt.retirementAt === null) return;
  if (
    (attempt.accepted && process.platform !== 'linux') ||
    observed === null ||
    attempt.launchedIncarnation === null ||
    observed !== attempt.launchedIncarnation
  ) {
    replacementHold(attempt, true);
    return;
  }
  const killDue = attempt.termDeliveredAt !== null && now - attempt.termDeliveredAt >= SENTINEL_TIMING.graceMs;
  if (!killDue && attempt.termDeliveredAt !== null) return;
  let sent = false;
  if (killDue) {
    try {
      sent = supervisor.kill('SIGKILL');
    } catch {
      /* The exact child may already have exited. */
    }
    attempt.killSent = sent;
  } else {
    try {
      sent = supervisor.kill('SIGTERM');
    } catch {
      /* The exact child may already have exited. */
    }
    if (sent) attempt.termDeliveredAt = now;
  }
  replacementHold(attempt, !sent);
}

function receiveReplacementMessage(attempt: ReplacementSupervisorAttempt, message: unknown): void {
  if (
    typeof message === 'object' &&
    message !== null &&
    (attempt.accepted || ('challenge' in message && message.challenge === attempt.challenge)) &&
    'kind' in message &&
    message.kind === 'coral-launch-status' &&
    'status' in message
  ) {
    receiveLaunchStatus(attempt.control.runDir, message.status);
    return;
  }
  if (
    typeof message !== 'object' ||
    message === null ||
    !('kind' in message) ||
    !('challenge' in message) ||
    message.challenge !== attempt.challenge
  )
    return;
  if (message.kind === 'coral-recovery-ready') {
    installReplacementSupervisorChannel(attempt.supervisor);
    attempt.supervisor.send({ kind: 'coral-recovery-offer', challenge: attempt.challenge });
  } else if (
    message.kind === 'coral-recovery-answer' &&
    attempt.accepted &&
    attempt.termDeliveredAt === null &&
    !attempt.killSent &&
    'id' in message &&
    message.id === attempt.outstanding &&
    attempt.outstanding !== null
  ) {
    attempt.lastAnswer = performance.now();
    attempt.outstanding = null;
    attempt.retirementAt = null;
    replacementHold(attempt, false);
    if ('normalized' in message && message.normalized === true) finishReplacementAttempt(attempt, null);
  } else if (
    message.kind === 'coral-recovery-owned' &&
    !attempt.accepted &&
    !attempt.settled &&
    attempt.termDeliveredAt === null &&
    !attempt.killSent
  ) {
    attempt.accepted = true;
    attempt.launchedIncarnation ??=
      attempt.supervisor.pid === undefined ? null : probeProcessIncarnation(attempt.supervisor.pid);
    attempt.lastAnswer = performance.now();
    attempt.lastWake = attempt.lastAnswer;
    attempt.retirementAt = null;
    clearTimeout(attempt.deadline);
    replacementHold(attempt, false);
    attempt.supervisor.unref();
  } else if (message.kind === 'coral-repair-bridge-ready') {
    attempt.bridgeReady = true;
  }
  if (attempt.accepted && attempt.bridgeReady && !attempt.repairStarted && !attempt.settled) {
    attempt.repairStarted = true;
    repairReplacementSupervisor(attempt);
  }
}

function servingSourceDisposition(
  control: ReplacementSupervisorControl,
  sourceIncarnation: ProcessIncarnation,
): 'matching' | 'superseded' | 'unknown' {
  try {
    const runtime = createRealRuntime(control.manifest.flavor, { baseDir: join(control.runDir, '..', '..') });
    const observed = readDiscoveryRecordDisposition(runtime);
    if (observed.kind !== 'record') return 'unknown';
    if (observed.record.incarnation === undefined) return 'unknown';
    if (observed.record.pid !== process.pid) return 'superseded';
    return observed.record.incarnation === sourceIncarnation ? 'matching' : 'superseded';
  } catch {
    return 'unknown';
  }
}

function launchReplacementSupervisor(control: ReplacementSupervisorControl): void {
  const sourceIncarnation = probeProcessIncarnation(process.pid);
  if (sourceIncarnation === null) {
    retryReplacementSupervisor(control, new Error('Coordinator process incarnation is unavailable'));
    return;
  }
  const root = validatedRunningBuildRoot(control.runDir, control.pluginRoot, control.manifest);
  if (root === null || !existsSync(join(root, 'bridge', 'coral-sentinel.cjs'))) {
    retryReplacementSupervisor(control, new Error('No validated supervisor executable for the running build'));
    return;
  }
  const challenge = randomUUID();
  const supervisor = spawn(
    process.execPath,
    [join(root, 'bridge', 'coral-sentinel.cjs'), join(root, 'bridge', 'coral-backend.cjs')],
    {
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: {
        ...control.env,
        CORAL_RECOVERY_SOURCE_PID: String(process.pid),
        CORAL_RECOVERY_SOURCE_INCARNATION: sourceIncarnation,
        CORAL_RECOVERY_CHALLENGE: challenge,
      },
    },
  );
  const launchedIncarnation = supervisor.pid === undefined ? null : probeProcessIncarnation(supervisor.pid);
  const attempt: ReplacementSupervisorAttempt = {
    control,
    root,
    sourceIncarnation,
    challenge,
    supervisor,
    settled: false,
    accepted: false,
    bridgeReady: false,
    repairStarted: false,
    lastAnswer: performance.now(),
    lastWake: performance.now(),
    sequence: 0,
    outstanding: null,
    launchedIncarnation,
    holdId: `replacement:${supervisor.pid ?? 'unavailable'}:${launchedIncarnation ?? challenge}`,
    retirementAt: null,
    termDeliveredAt: null,
    killSent: false,
    retirementPoll: null as unknown as ReturnType<typeof setInterval>,
    deadline: null as unknown as ReturnType<typeof setTimeout>,
  };
  attempt.retirementPoll = setInterval(() => pollReplacementRetirement(attempt), SENTINEL_TIMING.challengeMs);
  attempt.retirementPoll.unref();
  attempt.deadline = setTimeout(() => {
    attempt.retirementAt = performance.now();
  }, ACCEPTANCE_DEADLINE_MS);
  attempt.deadline.unref();
  supervisor.once('spawn', () => {
    attempt.launchedIncarnation ??= supervisor.pid === undefined ? null : probeProcessIncarnation(supervisor.pid);
  });
  supervisor.once('error', (error) => {
    if (supervisor.pid === undefined) finishReplacementAttempt(attempt, error);
    else {
      control.onError(error);
      replacementHold(attempt, true);
    }
  });
  supervisor.on('message', (message: unknown) => receiveReplacementMessage(attempt, message));
  supervisor.once('exit', (code, signal) => {
    replacementHold(attempt, false);
    if (!attempt.settled)
      finishReplacementAttempt(
        attempt,
        new Error(`Replacement supervisor exited before accepting ownership (${code ?? signal})`),
      );
    else if (servingSourceDisposition(control, sourceIncarnation) !== 'superseded')
      retryReplacementSupervisor(
        control,
        new Error(`Replacement supervisor exited after accepting ownership (${code ?? signal})`),
      );
  });
}

/** Acceptance cannot end monitoring before custody-preserving normalization. */
export function startReplacementSupervisor(
  pluginRoot: string,
  runDir: string,
  manifest: StrictBundleManifest,
  onError: (error: Error) => void,
  onAccepted: (pluginRoot: string) => Promise<void>,
): void {
  const env: NodeJS.ProcessEnv = { ...process.env, CORAL_SENTINEL_RUN_DIR: runDir };
  delete env.CORAL_LAUNCH_ADMISSION;
  delete env.CORAL_LAUNCH_ID;
  delete env.CORAL_LAUNCH_PURPOSE;
  delete env.CORAL_SENTINEL_ID;
  delete env.CORAL_STARTUP_ATTEMPT_ID;
  delete env.CORAL_SUCCESSION_ATTEMPT_ID;
  launchReplacementSupervisor({ pluginRoot, runDir, manifest, onError, onAccepted, env, failing: false });
}

/** A reused shipped incumbent still needs its outstanding upgrade observed under the namespace lock. */
export async function resumeLegacyUpgradeObservation(
  runDir: string,
  installedRoot: string,
  manifest: StrictBundleManifest | null,
  budgetMs: number,
): Promise<void> {
  const deadline = performance.now() + budgetMs;
  const observed = readUpgradeIntent(runDir);
  if (
    observed.kind !== 'readable' ||
    observed.intent.legacyRetirement !== true ||
    observed.intent.disposition === 'closed' ||
    observed.intent.disposition === 'completed'
  )
    return;
  const report = (observation: string | null): void => {
    try {
      updateLaunchStatus(runDir, (status) => ({
        ...status,
        hold:
          observation === null
            ? status.hold?.kind === 'observation-unavailable'
              ? undefined
              : status.hold
            : {
                kind: 'observation-unavailable',
                requestId: observed.intent.requestId,
                observation,
                retry: 'next-trigger',
              },
      }));
    } catch (error: unknown) {
      process.stderr.write(`Legacy upgrade observation status is unavailable: ${String(error)}\n`);
    }
  };
  try {
    const path = supervisorLockPath(runDir);
    if (existsSync(path)) {
      const lock = attemptExclusiveFileLockSync(path);
      if (lock.kind === 'contended') return;
      if (lock.kind === 'acquired') lock.lease();
    }
    const root =
      (manifest === null ? null : validatedRunningBuildRoot(runDir, installedRoot, manifest)) ??
      validatedRunningBuildRoot(runDir, observed.intent.target.pluginRootLabel, observed.intent.target.build);
    if (root === null) return report('no-validated-observer-build');
    if (performance.now() >= deadline) return report('acknowledgement-budget-exhausted');
    const bundleDir = join(root, 'bridge');
    const challenge = randomUUID();
    const child = spawn(
      process.execPath,
      [join(bundleDir, 'coral-sentinel.cjs'), join(bundleDir, 'coral-backend.cjs')],
      {
        detached: true,
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        env: { ...process.env, CORAL_SENTINEL_RUN_DIR: runDir, CORAL_OBSERVATION_CHALLENGE: challenge },
      },
    );
    try {
      const failure = await new Promise<string | null>((resolve) => {
        const finish = (reason: string | null): void => {
          clearTimeout(timeout);
          child.off('exit', exited);
          child.off('disconnect', disconnected);
          child.off('message', acknowledged);
          resolve(reason);
        };
        const exited = (): void => finish('observer-exited-before-acknowledgement');
        const disconnected = (): void => finish('observer-disconnected-before-acknowledgement');
        const acknowledged = (message: unknown): void => {
          if (
            typeof message === 'object' &&
            message !== null &&
            'kind' in message &&
            message.kind === 'coral-observation-owned' &&
            'challenge' in message &&
            message.challenge === challenge
          )
            finish(null);
        };
        const timeout = setTimeout(
          () => finish('observer-acknowledgement-timed-out'),
          Math.max(0, deadline - performance.now()),
        );
        child.once('error', (error) => finish(String(error)));
        child.once('exit', exited);
        child.once('disconnect', disconnected);
        child.on('message', acknowledged);
      });
      report(failure);
    } finally {
      if (child.connected) child.disconnect();
      child.unref();
    }
  } catch (error: unknown) {
    report(String(error));
  }
}
