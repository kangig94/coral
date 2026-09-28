import { CoordinatorLaunchRecord, type LaunchProcess } from './coordinator-launch.js';
import { probeProcessIncarnation } from './node-process.js';

type AdmissionMessage = Readonly<{
  kind: 'coral-launch-admit';
  runDir: string;
  launchId: string;
  ownerEpoch: number;
  parent: LaunchProcess;
}>;

function admissionMessage(value: unknown): value is AdmissionMessage {
  return typeof value === 'object' && value !== null && 'kind' in value && value.kind === 'coral-launch-admit';
}

export async function claimCoordinatorLaunch(): Promise<boolean> {
  if (process.env.CORAL_LAUNCH_ADMISSION !== '1') return true;
  const admitted = await new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => resolve(false), 10_000);
    process.once('message', (message: unknown) => {
      clearTimeout(timeout);
      if (!admissionMessage(message) || process.ppid !== message.parent.pid) return resolve(false);
      const parentIncarnation = probeProcessIncarnation(message.parent.pid);
      const childIncarnation = probeProcessIncarnation(process.pid);
      if (parentIncarnation !== message.parent.incarnation || childIncarnation === null) return resolve(false);
      const record = new CoordinatorLaunchRecord(message.runDir);
      try {
        const state = record.read();
        const reservation = [state.launch, state.attempt].find((launch) => launch?.id === message.launchId);
        const accepted =
          reservation !== undefined &&
          reservation !== null &&
          reservation.ownerEpoch === message.ownerEpoch &&
          record.admit(reservation, message.parent, { pid: process.pid, incarnation: childIncarnation }, Date.now());
        if (accepted) process.env.CORAL_LAUNCH_ID = reservation.id;
        resolve(accepted);
      } finally {
        record.close();
      }
    });
  });
  if (admitted) process.send?.({ kind: 'coral-launch-admitted', pid: process.pid });
  return admitted;
}
