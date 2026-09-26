import { join } from 'node:path';
import { z } from 'zod';

import type { Runtime } from '../../runtime/ports.js';

const retirementDispositionSchema = z
  .object({
    version: z.literal('v1'),
    attemptId: z.string().uuid(),
    incumbentEpochKey: z.string().min(1),
    incumbentFingerprint: z.string().min(1),
    successorFingerprint: z.string().min(1),
    certificateRevision: z.number().int().nonnegative(),
    certificateJobIds: z.array(z.string().min(1)),
    custodySettled: z.literal(true),
  })
  .passthrough();

export type RetirementDisposition = z.infer<typeof retirementDispositionSchema>;

function dispositionPath(runtime: Runtime, attemptId: string): string {
  return join(runtime.paths.coral.coordinator.runDir, 'retirement-dispositions.v1', `${attemptId}.json`);
}

export function recordRetirementDisposition(runtime: Runtime, disposition: RetirementDisposition): void {
  const validated = retirementDispositionSchema.parse(disposition);
  const path = dispositionPath(runtime, validated.attemptId);
  runtime.storage.mkdirSync(join(runtime.paths.coral.coordinator.runDir, 'retirement-dispositions.v1'), {
    recursive: true,
    mode: 0o700,
  });
  if (
    !runtime.storage.writeAtomicDurableSync(path, `${JSON.stringify(validated)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    })
  )
    throw new Error('Retirement disposition could not be recorded durably.');
}

export type RetirementDispositionRead =
  | Readonly<{ kind: 'recorded'; disposition: RetirementDisposition }>
  | Readonly<{ kind: 'absent' }>
  | Readonly<{ kind: 'unreadable'; path: string }>;

export function observeRetirementDisposition(runtime: Runtime, attemptId: string): RetirementDispositionRead {
  const path = dispositionPath(runtime, attemptId);
  let raw: string;
  try {
    raw = runtime.storage.readFileSync(path, 'utf-8');
  } catch (error: unknown) {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT'
      ? { kind: 'absent' }
      : { kind: 'unreadable', path };
  }
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return { kind: 'unreadable', path };
  }
  const parsed = retirementDispositionSchema.safeParse(value);
  return parsed.success ? { kind: 'recorded', disposition: parsed.data } : { kind: 'unreadable', path };
}
