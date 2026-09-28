import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { StrictBundleManifest } from '../infra/bundle-manifest.js';
import { CoordinatorLaunchRecord } from '../infra/coordinator-launch.js';
import { probeProcessIncarnation, type ProcessIncarnation } from '../infra/node-process.js';
import { SENTINEL_TIMING } from '../infra/sentinel-timing.js';
import { validatedRunningBuildRoot } from '../infra/retained-build-root.js';
import { installReplacementSupervisorChannel } from './succession-attempt.js';

const RETRY_MS = 1_000;
const ACCEPTANCE_DEADLINE_MS = 10_000;

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

  let failing = false;
  const retry = (error: Error): void => {
    if (!failing) onError(error);
    failing = true;
    setTimeout(start, RETRY_MS);
  };
  const startRepair = (root: string): void => {
    void onAccepted(root).catch((error: unknown) => {
      onError(error instanceof Error ? error : new Error(String(error)));
      setTimeout(() => startRepair(root), RETRY_MS);
    });
  };
  const start = (): void => {
    const sourceIncarnation = probeProcessIncarnation(process.pid);
    if (sourceIncarnation === null) {
      retry(new Error('Coordinator process incarnation is unavailable'));
      return;
    }
    const root = validatedRunningBuildRoot(runDir, pluginRoot, manifest);
    if (root === null || !existsSync(join(root, 'bridge', 'coral-sentinel.cjs'))) {
      retry(new Error('No validated supervisor executable for the running build'));
      return;
    }
    const record = new CoordinatorLaunchRecord(runDir);
    const challenge = randomUUID();
    const supervisor = spawn(
      process.execPath,
      [join(root, 'bridge', 'coral-sentinel.cjs'), join(root, 'bridge', 'coral-backend.cjs')],
      {
        detached: true,
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        env: {
          ...env,
          CORAL_RECOVERY_SOURCE_PID: String(process.pid),
          CORAL_RECOVERY_SOURCE_INCARNATION: sourceIncarnation,
          CORAL_RECOVERY_CHALLENGE: challenge,
        },
      },
    );
    let settled = false;
    let accepted = false;
    let channelReady = false;
    let bridgeReady = false;
    let offered: string | null = null;
    let launchedIncarnation: ProcessIncarnation | null = null;
    let retirementAt: number | null = null;
    let termSent = false;
    let killSent = false;
    const finish = (error: Error | null, repair = false): void => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      clearInterval(retirementPoll);
      clearTimeout(deadline);
      record.close();
      if (error === null) {
        if (repair) startRepair(root);
        supervisor.unref();
      } else retry(error);
    };
    const poll = setInterval(() => {
      try {
        const state = record.read();
        const owner = state.owner;
        if (
          !accepted &&
          owner !== null &&
          owner.process.pid === supervisor.pid &&
          owner.process.incarnation === probeProcessIncarnation(supervisor.pid) &&
          owner.buildSetId === manifest.buildSetId &&
          owner.leaseUntil > Date.now() &&
          channelReady
        ) {
          accepted = true;
          clearTimeout(deadline);
          if (launchedIncarnation !== null && supervisor.pid !== undefined)
            record.clearReplacementSignalRefusal({ pid: supervisor.pid, incarnation: launchedIncarnation });
          supervisor.unref();
        }
        if (accepted) {
          if (state.attempt !== null && state.attempt.phase !== 'exited') return;
          const repair =
            state.launch?.phase === 'serving' &&
            state.launch.child?.pid === process.pid &&
            state.launch.child.incarnation === sourceIncarnation;
          if (repair && !bridgeReady) return;
          finish(null, repair);
          return;
        }
        if (settled || !channelReady || offered !== null || supervisor.pid === undefined) return;
        const nomineeIncarnation = probeProcessIncarnation(supervisor.pid);
        if (nomineeIncarnation === null) return;
        launchedIncarnation ??= nomineeIncarnation;
        const id = record.nominateRecovery(
          { pid: process.pid, incarnation: sourceIncarnation },
          { pid: supervisor.pid, incarnation: nomineeIncarnation },
          challenge,
        );
        if (id === null) return;
        offered = id;
        supervisor.send({ kind: 'coral-recovery-offer', id, challenge });
      } catch (error: unknown) {
        onError(error instanceof Error ? error : new Error(String(error)));
      }
    }, 200);
    poll.unref();
    const retirementPoll = setInterval(() => {
      if (settled || accepted || retirementAt === null || supervisor.pid === undefined || killSent) return;
      const observed = probeProcessIncarnation(supervisor.pid);
      launchedIncarnation ??= observed;
      if (observed === null || observed !== launchedIncarnation) return;
      const replacement = { pid: supervisor.pid, incarnation: observed };
      if (Date.now() - retirementAt < SENTINEL_TIMING.graceMs) {
        if (termSent) return;
        try {
          termSent = supervisor.kill('SIGTERM');
        } catch {
          termSent = false;
        }
        if (termSent) record.clearReplacementSignalRefusal(replacement);
        else record.holdReplacementSignalRefusal({ pid: process.pid, incarnation: sourceIncarnation }, replacement);
        return;
      }
      try {
        killSent = supervisor.kill('SIGKILL');
      } catch {
        killSent = false;
      }
      if (killSent) record.clearReplacementSignalRefusal(replacement);
      else record.holdReplacementSignalRefusal({ pid: process.pid, incarnation: sourceIncarnation }, replacement);
    }, 1_000);
    retirementPoll.unref();
    const deadline = setTimeout(() => {
      retirementAt = Date.now();
    }, ACCEPTANCE_DEADLINE_MS);
    deadline.unref();
    supervisor.once('error', finish);
    supervisor.on('message', (message: unknown) => {
      if (
        typeof message === 'object' &&
        message !== null &&
        'kind' in message &&
        message.kind === 'coral-repair-bridge-ready' &&
        'challenge' in message &&
        message.challenge === challenge
      ) {
        bridgeReady = true;
        return;
      }
      if (
        typeof message !== 'object' ||
        message === null ||
        !('kind' in message) ||
        message.kind !== 'coral-recovery-ready' ||
        !('challenge' in message) ||
        message.challenge !== challenge
      )
        return;
      channelReady = true;
      installReplacementSupervisorChannel(supervisor);
    });
    supervisor.once('exit', (code, signal) => {
      if (!settled) {
        if (launchedIncarnation !== null && supervisor.pid !== undefined)
          record.clearReplacementSignalRefusal({ pid: supervisor.pid, incarnation: launchedIncarnation });
        finish(new Error(`Replacement supervisor exited before accepting ownership (${code ?? signal})`));
        return;
      }
      const current = new CoordinatorLaunchRecord(runDir);
      try {
        if (launchedIncarnation !== null && supervisor.pid !== undefined)
          current.clearReplacementSignalRefusal({ pid: supervisor.pid, incarnation: launchedIncarnation });
        const state = current.read();
        if (
          [state.launch, state.attempt].some(
            (slot) =>
              slot?.phase === 'serving' &&
              slot.child?.pid === process.pid &&
              slot.child.incarnation === sourceIncarnation,
          )
        )
          retry(new Error(`Replacement supervisor exited after accepting ownership (${code ?? signal})`));
      } finally {
        current.close();
      }
    });
  };
  start();
}
