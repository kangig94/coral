import { claimCoordinatorLaunch } from '../infra/coordinator-admission.js';

/** Admit a shipped backend with this supervisor's protocol before loading its entry point. */
export async function launchLegacyBackend(executable: string, args: readonly string[]): Promise<void> {
  if (!(await claimCoordinatorLaunch())) {
    process.exitCode = 1;
    return;
  }
  delete process.env.CORAL_LAUNCH_ADMISSION;
  process.argv = [process.execPath, executable, ...args];
  await import(executable);
}
