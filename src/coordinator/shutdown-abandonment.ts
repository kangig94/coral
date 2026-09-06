import { join } from 'node:path';
import { z } from 'zod';

import type { StoragePort, TimePort } from '../infra/port-types.js';
import { nowIsoString } from '../infra/time.js';
import {
  type ShutdownObligationAbandonmentReceipt,
  type ShutdownObligationSubject,
} from '../obligation/shutdown-abandonment.js';

const SHUTDOWN_ABANDONMENT_STATUS_VERSION = 1;
const durableShutdownObligationSubjectSchema = z.enum([
  'recovery-coordinator-teardown',
  'kb-child-shutdown',
  'provider-operation-mutation-drain',
  'provider-host-shutdown',
  'child-termination',
  'app-server-handoff-quiesce',
  'provider-host-drain-for-handoff',
  'process-incarnation-probe-shutdown',
  'lifecycle-reactor-dispose',
  'provider-control-and-ipc-authority-release',
]);
const durableShutdownObligationAbandonmentReceiptSchema = z
  .object({
    subject: durableShutdownObligationSubjectSchema,
    instanceId: z.string().min(1),
    recordedAt: z.string().datetime(),
    disposition: z.literal('abandoned-unconfirmed'),
    detail: z.string().min(1),
    statusPath: z.string().min(1),
  })
  .strict();
const shutdownAbandonmentStatusSchema = z
  .object({
    version: z.literal(SHUTDOWN_ABANDONMENT_STATUS_VERSION),
    entries: z.array(durableShutdownObligationAbandonmentReceiptSchema).readonly(),
  })
  .strict();

export type ShutdownAbandonmentStatus = z.infer<typeof shutdownAbandonmentStatusSchema>;

export type ShutdownAbandonmentStatusRead =
  | Readonly<{ kind: 'available'; path: string; status: ShutdownAbandonmentStatus }>
  | Readonly<{ kind: 'absent'; path: string }>
  | Readonly<{ kind: 'unreadable'; path: string; detail: string }>;

type ShutdownAbandonmentRuntime = Readonly<{
  storage: Pick<StoragePort, 'existsSync' | 'readFileSync' | 'writeAtomicDurableSync'>;
  time: Pick<TimePort, 'now'>;
  runDir: string;
}>;

export function shutdownAbandonmentStatusPath(runDir: string): string {
  return join(runDir, 'shutdown-abandonment-status.v1.json');
}

export function readShutdownAbandonmentStatus(
  runtime: Pick<ShutdownAbandonmentRuntime, 'storage' | 'runDir'>,
): ShutdownAbandonmentStatusRead {
  const path = shutdownAbandonmentStatusPath(runtime.runDir);
  if (!runtime.storage.existsSync(path)) return { kind: 'absent', path };
  try {
    const parsed = shutdownAbandonmentStatusSchema.safeParse(JSON.parse(runtime.storage.readFileSync(path, 'utf-8')));
    return parsed.success
      ? { kind: 'available', path, status: parsed.data }
      : { kind: 'unreadable', path, detail: parsed.error.message };
  } catch (error: unknown) {
    return {
      kind: 'unreadable',
      path,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export function recordShutdownObligationAbandonment(
  runtime: ShutdownAbandonmentRuntime,
  input: Readonly<{ subject: ShutdownObligationSubject; instanceId: string; detail: string }>,
):
  | Readonly<{ kind: 'recorded'; receipt: ShutdownObligationAbandonmentReceipt }>
  | Readonly<{ kind: 'refused'; detail: string }> {
  const current = readShutdownAbandonmentStatus(runtime);
  if (current.kind === 'unreadable') {
    return { kind: 'refused', detail: `existing status is unreadable: ${current.detail}` };
  }
  const path = current.path;
  const receipt: ShutdownObligationAbandonmentReceipt = {
    subject: input.subject,
    instanceId: input.instanceId,
    recordedAt: nowIsoString(runtime.time),
    disposition: 'abandoned-unconfirmed',
    detail: input.detail,
    statusPath: path,
  };
  const entries = current.kind === 'available' ? current.status.entries : [];
  const status: ShutdownAbandonmentStatus = {
    version: SHUTDOWN_ABANDONMENT_STATUS_VERSION,
    entries: [
      ...entries.filter((entry) => entry.instanceId !== input.instanceId || entry.subject !== input.subject),
      receipt,
    ],
  };
  try {
    const published = runtime.storage.writeAtomicDurableSync(path, `${JSON.stringify(status, null, 2)}\n`, {
      encoding: 'utf-8',
      mode: 0o600,
    });
    return published
      ? { kind: 'recorded', receipt }
      : { kind: 'refused', detail: 'atomic durable status publication was not confirmed' };
  } catch (error: unknown) {
    return { kind: 'refused', detail: error instanceof Error ? error.message : String(error) };
  }
}
