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
  challenge: string;
  supervisor: ChildProcess;
  settled: boolean;
  accepted: boolean;
  bridgeReady: boolean;
  launchedIncarnation: ProcessIncarnation | null;
  retirementAt: number | null;
  termSent: boolean;
  killSent: boolean;
  retirementPoll: ReturnType<typeof setInterval>;
  deadline: ReturnType<typeof setTimeout>;
};

function retryReplacementSupervisor(control: ReplacementSupervisorControl, error: Error): void {
  if (!control.failing) control.onError(error);
  control.failing = true;
  setTimeout(() => launchReplacementSupervisor(control), RETRY_MS);
}

function repairReplacementSupervisor(control: ReplacementSupervisorControl, root: string): void {
  const retry = (): void => {
    const sourceIncarnation = probeProcessIncarnation(process.pid);
    if (sourceIncarnation === null) return;
    setTimeout(() => {
      const observed = readUpgradeIntent(control.runDir);
      const completed =
        observed.kind === 'readable' &&
        observed.intent.disposition === 'completed' &&
        observed.intent.incumbent.pid === process.pid &&
        observed.intent.incumbent.incarnation === sourceIncarnation;
      if (!completed && servingSourceStillPresent(control, sourceIncarnation))
        repairReplacementSupervisor(control, root);
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
  clearInterval(attempt.retirementPoll);
  clearTimeout(attempt.deadline);
  if (error === null) {
    repairReplacementSupervisor(attempt.control, attempt.root);
    attempt.supervisor.unref();
  } else retryReplacementSupervisor(attempt.control, error);
}

function replacementHold(attempt: ReplacementSupervisorAttempt, held: boolean): void {
  const pid = attempt.supervisor.pid;
  const incarnation = attempt.launchedIncarnation;
  if (pid === undefined || incarnation === null) return;
  const launchId = `replacement:${pid}:${incarnation}`;
  try {
    updateLaunchStatus(attempt.control.runDir, (status) => ({
      ...status,
      signalHolds: held
        ? [...status.signalHolds.filter((entry) => entry.launchId !== launchId), { launchId, pid, incarnation }]
        : status.signalHolds.filter((entry) => entry.launchId !== launchId),
    }));
  } catch (error: unknown) {
    attempt.control.onError(new Error(`Replacement supervisor signal status could not be written: ${String(error)}`));
  }
}

function pollReplacementRetirement(attempt: ReplacementSupervisorAttempt): void {
  const { supervisor } = attempt;
  if (
    attempt.settled ||
    attempt.accepted ||
    attempt.retirementAt === null ||
    supervisor.pid === undefined ||
    attempt.killSent
  )
    return;
  const observed = probeProcessIncarnation(supervisor.pid);
  attempt.launchedIncarnation ??= observed;
  if (observed === null || observed !== attempt.launchedIncarnation) return;
  const killDue = Date.now() - attempt.retirementAt >= SENTINEL_TIMING.graceMs;
  if (!killDue && attempt.termSent) return;
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
    attempt.termSent = sent;
  }
  replacementHold(attempt, !sent);
}

function receiveReplacementMessage(attempt: ReplacementSupervisorAttempt, message: unknown): void {
  if (
    attempt.accepted &&
    typeof message === 'object' &&
    message !== null &&
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
  } else if (message.kind === 'coral-recovery-owned') {
    attempt.accepted = true;
    clearTimeout(attempt.deadline);
    replacementHold(attempt, false);
    attempt.supervisor.unref();
    if (attempt.bridgeReady) finishReplacementAttempt(attempt, null);
  } else if (message.kind === 'coral-repair-bridge-ready') {
    attempt.bridgeReady = true;
    if (attempt.accepted) finishReplacementAttempt(attempt, null);
  }
}

function servingSourceStillPresent(
  control: ReplacementSupervisorControl,
  sourceIncarnation: ProcessIncarnation,
): boolean {
  try {
    const runtime = createRealRuntime(control.manifest.flavor, { baseDir: join(control.runDir, '..', '..') });
    const observed = readDiscoveryRecordDisposition(runtime);
    return (
      observed.kind === 'record' &&
      observed.record.pid === process.pid &&
      observed.record.incarnation === sourceIncarnation
    );
  } catch {
    return true;
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
  const attempt: ReplacementSupervisorAttempt = {
    control,
    root,
    challenge,
    supervisor,
    settled: false,
    accepted: false,
    bridgeReady: false,
    launchedIncarnation: null,
    retirementAt: null,
    termSent: false,
    killSent: false,
    retirementPoll: null as unknown as ReturnType<typeof setInterval>,
    deadline: null as unknown as ReturnType<typeof setTimeout>,
  };
  attempt.retirementPoll = setInterval(() => pollReplacementRetirement(attempt), 1_000);
  attempt.retirementPoll.unref();
  attempt.deadline = setTimeout(() => {
    attempt.retirementAt = Date.now();
  }, ACCEPTANCE_DEADLINE_MS);
  attempt.deadline.unref();
  supervisor.once('error', (error) => finishReplacementAttempt(attempt, error));
  supervisor.on('message', (message: unknown) => receiveReplacementMessage(attempt, message));
  supervisor.once('exit', (code, signal) => {
    replacementHold(attempt, false);
    if (!attempt.settled)
      finishReplacementAttempt(
        attempt,
        new Error(`Replacement supervisor exited before accepting ownership (${code ?? signal})`),
      );
    else if (servingSourceStillPresent(control, sourceIncarnation))
      retryReplacementSupervisor(
        control,
        new Error(`Replacement supervisor exited after accepting ownership (${code ?? signal})`),
      );
  });
}

/** A surviving coordinator keeps serving until a replacement accepts launch ownership. */
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
