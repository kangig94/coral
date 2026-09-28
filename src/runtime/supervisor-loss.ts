import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { StrictBundleManifest } from '../infra/bundle-manifest.js';
import { CoordinatorLaunchRecord } from '../infra/coordinator-launch.js';
import { validatedRunningBuildRoot } from '../infra/retained-build-root.js';

const RETRY_MS = 1_000;
const ACCEPTANCE_DEADLINE_MS = 10_000;

/** A surviving coordinator keeps serving until a replacement accepts launch ownership; exit 0 is read as acceptance. */
export function startReplacementSupervisor(
  pluginRoot: string,
  runDir: string,
  manifest: StrictBundleManifest,
  onError: (error: Error) => void,
): void {
  const env: NodeJS.ProcessEnv = { ...process.env, CORAL_SENTINEL_RUN_DIR: runDir };
  delete env.CORAL_LAUNCH_ADMISSION;
  delete env.CORAL_LAUNCH_PURPOSE;
  delete env.CORAL_SENTINEL_ID;
  delete env.CORAL_STARTUP_ATTEMPT_ID;
  delete env.CORAL_SUCCESSION_ATTEMPT_ID;

  const record = new CoordinatorLaunchRecord(runDir);
  let failing = false;
  const retry = (error: Error): void => {
    if (!failing) onError(error);
    failing = true;
    setTimeout(start, RETRY_MS).unref();
  };
  const start = (): void => {
    const root = validatedRunningBuildRoot(runDir, pluginRoot, manifest);
    if (root === null || !existsSync(join(root, 'bridge', 'coral-sentinel.cjs'))) {
      retry(new Error('No validated supervisor executable for the running build'));
      return;
    }
    const supervisor = spawn(
      process.execPath,
      [join(root, 'bridge', 'coral-sentinel.cjs'), join(root, 'bridge', 'coral-backend.cjs')],
      { detached: true, stdio: 'ignore', env },
    );
    let settled = false;
    const finish = (error: Error | null): void => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      clearTimeout(deadline);
      if (error === null) {
        record.close();
        supervisor.unref();
      } else retry(error);
    };
    const poll = setInterval(() => {
      try {
        const owner = record.read().owner;
        if (
          owner !== null &&
          owner.process.pid === supervisor.pid &&
          owner.buildSetId === manifest.buildSetId &&
          owner.leaseUntil > Date.now()
        )
          finish(null);
      } catch (error: unknown) {
        onError(error instanceof Error ? error : new Error(String(error)));
      }
    }, 200);
    poll.unref();
    const deadline = setTimeout(() => supervisor.kill('SIGTERM'), ACCEPTANCE_DEADLINE_MS);
    deadline.unref();
    supervisor.once('error', finish);
    supervisor.once('exit', (code, signal) =>
      finish(
        code === 0 ? null : new Error(`Replacement supervisor exited before accepting ownership (${code ?? signal})`),
      ),
    );
  };
  start();
}
