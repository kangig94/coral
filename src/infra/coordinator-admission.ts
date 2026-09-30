import { receiveLaunchStatus } from './launch-status.js';
import { publishLaunchAdmission, readLaunchAdmission, removeOwnLaunchAdmission } from './launch-admission-record.js';
import { probeProcessIncarnation, type ProcessIncarnation } from './node-process.js';

type AdmissionMessage = Readonly<{
  kind: 'coral-launch-admit';
  runDir: string;
  launchId: string;
  build: Readonly<{ version: string; buildSetId: string; bundleHash: string; flavor: 'prod' | 'dev' }>;
  purpose: 'startup' | 'contender' | 'succession' | 'recovery' | 'legacy-retirement';
  parent: Readonly<{ pid: number; incarnation: ProcessIncarnation }>;
}>;

let authenticatedParent: AdmissionMessage['parent'] | null = null;

/** Later observations cannot replace the parent tuple authenticated during launch admission. */
export function authenticatedLaunchParent(): AdmissionMessage['parent'] | null {
  return authenticatedParent;
}

function admissionMessage(value: unknown): value is AdmissionMessage {
  return typeof value === 'object' && value !== null && 'kind' in value && value.kind === 'coral-launch-admit';
}

export async function claimCoordinatorLaunch(): Promise<boolean> {
  if (process.env.CORAL_LAUNCH_ADMISSION !== '1') return true;
  return new Promise<boolean>((resolve) => {
    let launchId: string | null = null;
    let runDir = '';
    let settled = false;
    const finish = (admitted: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      process.off('disconnect', disconnected);
      process.off('message', receiveAdmission);
      process.off('message', acknowledged);
      if (admitted) {
        const abortBeforeArm = (): void => process.exit(1);
        const armed = (message: unknown): void => {
          if (typeof message !== 'object' || message === null || !('kind' in message)) return;
          if (message.kind !== 'coral-sentinel-armed') return;
          process.off('disconnect', abortBeforeArm);
          process.off('message', armed);
        };
        process.on('disconnect', abortBeforeArm);
        process.on('message', armed);
      } else if (launchId !== null) removeOwnLaunchAdmission(runDir, launchId);
      resolve(admitted);
    };
    const disconnected = (): void => finish(false);
    const acknowledged = (message: unknown): void => {
      if (
        typeof message === 'object' &&
        message !== null &&
        'kind' in message &&
        message.kind === 'coral-launch-acknowledged' &&
        'launchId' in message &&
        message.launchId === launchId
      )
        finish(true);
    };
    const receiveAdmission = (message: unknown): void => {
      if (!admissionMessage(message) || process.ppid !== message.parent.pid) return finish(false);
      const parentIncarnation = probeProcessIncarnation(message.parent.pid);
      const childIncarnation = probeProcessIncarnation(process.pid);
      if (parentIncarnation !== message.parent.incarnation || childIncarnation === null || !process.connected)
        return finish(false);
      authenticatedParent = Object.freeze({ ...message.parent });
      runDir = message.runDir;
      process.on('message', (value: unknown) => {
        if (
          typeof value === 'object' &&
          value !== null &&
          'kind' in value &&
          value.kind === 'coral-launch-status' &&
          'status' in value
        )
          receiveLaunchStatus(runDir, value.status);
      });
      launchId = message.launchId;
      publishLaunchAdmission(message.runDir, {
        version: 1,
        launchId: message.launchId,
        child: { pid: process.pid, incarnation: childIncarnation },
        parent: message.parent,
        admittedAt: Date.now(),
        build: message.build,
        purpose: message.purpose,
      });
      if (!process.connected) return finish(false);
      process.env.CORAL_LAUNCH_ID = message.launchId;
      process.on('exit', () => removeOwnLaunchAdmission(message.runDir, message.launchId));
      process.on('message', acknowledged);
      process.send?.({ kind: 'coral-launch-admitted', pid: process.pid, launchId: message.launchId });
    };
    const timeout = setTimeout(() => finish(false), 10_000);
    process.once('disconnect', disconnected);
    process.once('message', receiveAdmission);
  });
}

export function notifyLaunchDiscovery(runDir: string, launchId: string): void {
  const record = readLaunchAdmission(runDir, launchId);
  if (
    record.kind !== 'readable' ||
    record.admission.child.pid !== process.pid ||
    record.admission.child.incarnation !== probeProcessIncarnation(process.pid)
  )
    throw new Error('Coordinator discovery cannot update another child admission identity.');
  publishLaunchAdmission(runDir, { ...record.admission, discoveredAt: Date.now() });
  if (process.connected) process.send?.({ kind: 'coral-launch-discovered', pid: process.pid, launchId });
}
