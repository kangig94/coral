import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

/** A surviving coordinator keeps serving while a new supervisor takes launch ownership. */
export function startReplacementSupervisor(pluginRoot: string, onError: (error: Error) => void): void {
  const env = { ...process.env };
  delete env.CORAL_LAUNCH_ADMISSION;
  delete env.CORAL_LAUNCH_PURPOSE;
  delete env.CORAL_SENTINEL_ID;
  const supervisor = spawn(
    process.execPath,
    [resolve(pluginRoot, 'bridge', 'coral-sentinel.cjs'), resolve(pluginRoot, 'bridge', 'coral-backend.cjs')],
    { detached: true, stdio: 'ignore', env },
  );
  supervisor.once('error', onError);
  supervisor.unref();
}
