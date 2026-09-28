import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { StrictBundleManifest } from '../infra/bundle-manifest.js';
import { CoordinatorLaunchRecord } from '../infra/coordinator-launch.js';
import { probeProcessIncarnation } from '../infra/node-process.js';
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
    let channelReady = false;
    let bridgeReady = false;
    let offered: string | null = null;
    const finish = (error: Error | null): void => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      clearTimeout(deadline);
      const shouldRepair = error === null && (offered !== null || record.read().attempt === null);
      record.close();
      if (error === null) {
        if (shouldRepair) startRepair(root);
        supervisor.unref();
      } else retry(error);
    };
    const poll = setInterval(() => {
      try {
        const state = record.read();
        const owner = state.owner;
        if (
          owner !== null &&
          owner.process.pid === supervisor.pid &&
          owner.process.incarnation === probeProcessIncarnation(supervisor.pid) &&
          owner.buildSetId === manifest.buildSetId &&
          owner.leaseUntil > Date.now() &&
          channelReady &&
          bridgeReady
        )
          finish(null);
        if (settled || !channelReady || offered !== null || supervisor.pid === undefined) return;
        const nomineeIncarnation = probeProcessIncarnation(supervisor.pid);
        if (nomineeIncarnation === null) return;
        const id = record.nominateRecovery(
          { pid: process.pid, incarnation: sourceIncarnation },
          { pid: supervisor.pid, incarnation: nomineeIncarnation },
          challenge,
          Date.now(),
        );
        if (id === null) return;
        offered = id;
        supervisor.send({ kind: 'coral-recovery-offer', id, challenge });
      } catch (error: unknown) {
        onError(error instanceof Error ? error : new Error(String(error)));
      }
    }, 200);
    poll.unref();
    const deadline = setTimeout(() => supervisor.kill('SIGTERM'), ACCEPTANCE_DEADLINE_MS);
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
        finish(new Error(`Replacement supervisor exited before accepting ownership (${code ?? signal})`));
        return;
      }
      const current = new CoordinatorLaunchRecord(runDir);
      try {
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
