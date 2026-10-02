import { closeHandle } from '../infra/ipc-handle.js';
import { claimCoordinatorLaunch } from '../infra/coordinator-admission.js';

export async function launchLegacyBackend(executable: string, args: readonly string[]): Promise<void> {
  if (!(await claimCoordinatorLaunch())) {
    process.exitCode = 1;
    return;
  }
  delete process.env.CORAL_LAUNCH_ADMISSION;
  const sentinelId = process.env.CORAL_SENTINEL_ID;
  if (sentinelId !== undefined && process.send !== undefined) {
    process.on('message', (message: unknown, handle: unknown) => {
      if (
        typeof message === 'object' &&
        message !== null &&
        'kind' in message &&
        message.kind === 'coral-sentinel-challenge'
      )
        closeHandle(handle);
      if (
        typeof message === 'object' &&
        message !== null &&
        'kind' in message &&
        message.kind === 'coral-sentinel-challenge' &&
        'id' in message &&
        Number.isSafeInteger(message.id)
      )
        process.send?.({ kind: 'coral-sentinel-answer', id: message.id });
    });
    process.send({ kind: 'coral-sentinel-hello', id: sentinelId });
  }
  process.argv = [process.execPath, executable, ...args];
  await import(executable);
}
