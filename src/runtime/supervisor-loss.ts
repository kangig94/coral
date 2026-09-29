import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { StrictBundleManifest } from '../infra/bundle-manifest.js';
import { CoordinatorLaunchRecord, type LaunchProcess } from '../infra/coordinator-launch.js';
import { probeProcessIncarnation, type ProcessIncarnation } from '../infra/node-process.js';
import { SENTINEL_TIMING } from '../infra/sentinel-timing.js';
import { validatedRunningBuildRoot } from '../infra/retained-build-root.js';
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
  record: CoordinatorLaunchRecord;
  challenge: string;
  supervisor: ReturnType<typeof spawn>;
  settled: boolean;
  accepted: boolean;
  channelReady: boolean;
  bridgeReady: boolean;
  offered: string | null;
  launchedIncarnation: ProcessIncarnation | null;
  retirementAt: number | null;
  termSent: boolean;
  killSent: boolean;
  holdRefusalReported: boolean;
  poll: ReturnType<typeof setInterval> | null;
  retirementPoll: ReturnType<typeof setInterval> | null;
  deadline: ReturnType<typeof setTimeout> | null;
};

function retryReplacementSupervisor(control: ReplacementSupervisorControl, error: Error): void {
  if (!control.failing) control.onError(error);
  control.failing = true;
  setTimeout(() => launchReplacementSupervisor(control), RETRY_MS);
}

function repairReplacementSupervisor(control: ReplacementSupervisorControl, root: string): void {
  void control.onAccepted(root).catch((error: unknown) => {
    control.onError(error instanceof Error ? error : new Error(String(error)));
    setTimeout(() => repairReplacementSupervisor(control, root), RETRY_MS);
  });
}

function finishReplacementAttempt(attempt: ReplacementSupervisorAttempt, error: Error | null, repair = false): void {
  if (attempt.settled) return;
  attempt.settled = true;
  if (attempt.poll !== null) clearInterval(attempt.poll);
  if (attempt.retirementPoll !== null) clearInterval(attempt.retirementPoll);
  if (attempt.deadline !== null) clearTimeout(attempt.deadline);
  attempt.record.close();
  if (error === null) {
    if (repair) repairReplacementSupervisor(attempt.control, attempt.root);
    attempt.supervisor.unref();
  } else retryReplacementSupervisor(attempt.control, error);
}

function holdReplacementSignalRefusal(attempt: ReplacementSupervisorAttempt, replacement: LaunchProcess): void {
  const { control, record, sourceIncarnation } = attempt;
  const held = record.holdReplacementSignalRefusal({ pid: process.pid, incarnation: sourceIncarnation }, replacement);
  if (held) {
    attempt.holdRefusalReported = false;
  } else if (!attempt.holdRefusalReported) {
    attempt.holdRefusalReported = true;
    control.onError(new Error(`Replacement supervisor signal hold refused for PID ${replacement.pid}`));
  }
}

function pollReplacementOwnership(attempt: ReplacementSupervisorAttempt): void {
  const { control, record, supervisor, sourceIncarnation, challenge } = attempt;
  try {
    const state = record.read();
    const owner = state.owner;
    if (
      !attempt.accepted &&
      owner !== null &&
      owner.process.pid === supervisor.pid &&
      owner.process.incarnation === probeProcessIncarnation(supervisor.pid) &&
      owner.buildSetId === control.manifest.buildSetId &&
      owner.leaseUntil > Date.now() &&
      attempt.channelReady
    ) {
      attempt.accepted = true;
      if (attempt.deadline !== null) clearTimeout(attempt.deadline);
      if (attempt.launchedIncarnation !== null && supervisor.pid !== undefined)
        record.clearReplacementSignalRefusal({ pid: supervisor.pid, incarnation: attempt.launchedIncarnation });
      supervisor.unref();
    }
    if (attempt.accepted) {
      if (state.attempt !== null && state.attempt.phase !== 'exited') return;
      const repair =
        state.launch?.phase === 'serving' &&
        state.launch.child?.pid === process.pid &&
        state.launch.child.incarnation === sourceIncarnation;
      if (repair && !attempt.bridgeReady) return;
      finishReplacementAttempt(attempt, null, repair);
      return;
    }
    if (
      attempt.settled ||
      attempt.retirementAt !== null ||
      !attempt.channelReady ||
      attempt.offered !== null ||
      supervisor.pid === undefined
    )
      return;
    const nomineeIncarnation = probeProcessIncarnation(supervisor.pid);
    if (nomineeIncarnation === null) return;
    attempt.launchedIncarnation ??= nomineeIncarnation;
    const id = record.nominateRecovery(
      { pid: process.pid, incarnation: sourceIncarnation },
      { pid: supervisor.pid, incarnation: nomineeIncarnation },
      challenge,
    );
    if (id === null) return;
    attempt.offered = id;
    supervisor.send({ kind: 'coral-recovery-offer', id, challenge });
  } catch (error: unknown) {
    control.onError(error instanceof Error ? error : new Error(String(error)));
  }
}

function pollReplacementRetirement(attempt: ReplacementSupervisorAttempt): void {
  const { record, supervisor, sourceIncarnation } = attempt;
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
  const replacement = { pid: supervisor.pid, incarnation: observed };
  if (!record.cancelRecoveryForTermination({ pid: process.pid, incarnation: sourceIncarnation }, replacement)) return;
  if (Date.now() - attempt.retirementAt < SENTINEL_TIMING.graceMs) {
    if (attempt.termSent) return;
    try {
      attempt.termSent = supervisor.kill('SIGTERM');
    } catch {
      attempt.termSent = false;
    }
    if (attempt.termSent) record.clearReplacementSignalRefusal(replacement);
    else holdReplacementSignalRefusal(attempt, replacement);
    return;
  }
  try {
    attempt.killSent = supervisor.kill('SIGKILL');
  } catch {
    attempt.killSent = false;
  }
  if (attempt.killSent) record.clearReplacementSignalRefusal(replacement);
  else holdReplacementSignalRefusal(attempt, replacement);
}

function receiveReplacementMessage(attempt: ReplacementSupervisorAttempt, message: unknown): void {
  if (
    typeof message === 'object' &&
    message !== null &&
    'kind' in message &&
    message.kind === 'coral-repair-bridge-ready' &&
    'challenge' in message &&
    message.challenge === attempt.challenge
  ) {
    attempt.bridgeReady = true;
    return;
  }
  if (
    typeof message !== 'object' ||
    message === null ||
    !('kind' in message) ||
    message.kind !== 'coral-recovery-ready' ||
    !('challenge' in message) ||
    message.challenge !== attempt.challenge
  )
    return;
  attempt.channelReady = true;
  installReplacementSupervisorChannel(attempt.supervisor);
}

function observeReplacementExit(
  attempt: ReplacementSupervisorAttempt,
  code: number | null,
  signal: NodeJS.Signals | null,
): void {
  const { control, record, supervisor, sourceIncarnation } = attempt;
  if (!attempt.settled) {
    if (attempt.launchedIncarnation !== null && supervisor.pid !== undefined)
      record.clearReplacementSignalRefusal({ pid: supervisor.pid, incarnation: attempt.launchedIncarnation });
    finishReplacementAttempt(
      attempt,
      new Error(`Replacement supervisor exited before accepting ownership (${code ?? signal})`),
    );
    return;
  }
  const current = new CoordinatorLaunchRecord(control.runDir);
  try {
    if (attempt.launchedIncarnation !== null && supervisor.pid !== undefined)
      current.clearReplacementSignalRefusal({ pid: supervisor.pid, incarnation: attempt.launchedIncarnation });
    const state = current.read();
    if (
      [state.launch, state.attempt].some(
        (slot) =>
          slot?.phase === 'serving' && slot.child?.pid === process.pid && slot.child.incarnation === sourceIncarnation,
      )
    )
      retryReplacementSupervisor(
        control,
        new Error(`Replacement supervisor exited after accepting ownership (${code ?? signal})`),
      );
  } finally {
    current.close();
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
  const record = new CoordinatorLaunchRecord(control.runDir);
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
    sourceIncarnation,
    record,
    challenge,
    supervisor,
    settled: false,
    accepted: false,
    channelReady: false,
    bridgeReady: false,
    offered: null,
    launchedIncarnation: null,
    retirementAt: null,
    termSent: false,
    killSent: false,
    holdRefusalReported: false,
    poll: null,
    retirementPoll: null,
    deadline: null,
  };
  attempt.poll = setInterval(() => pollReplacementOwnership(attempt), 200);
  attempt.poll.unref();
  attempt.retirementPoll = setInterval(() => pollReplacementRetirement(attempt), 1_000);
  attempt.retirementPoll.unref();
  attempt.deadline = setTimeout(() => {
    attempt.retirementAt = Date.now();
  }, ACCEPTANCE_DEADLINE_MS);
  attempt.deadline.unref();
  supervisor.once('error', (error) => finishReplacementAttempt(attempt, error));
  supervisor.on('message', (message: unknown) => receiveReplacementMessage(attempt, message));
  supervisor.once('exit', (code, signal) => observeReplacementExit(attempt, code, signal));
}

/** A surviving coordinator keeps serving until a replacement accepts launch ownership; exit 0 is read as acceptance. */
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
