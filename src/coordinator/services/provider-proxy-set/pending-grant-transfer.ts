import { join } from 'node:path';

import { z } from 'zod';

import {
  handoffCapsuleControllerBuildSetId,
  type RedeemableHandoffCapsule,
} from '../../../provider-proxy/handoff-capsule.js';
import type { Runtime } from '../../../runtime/ports.js';
import { providerProxySetIdentityFromCapsule, providerProxySetKey } from './identity.js';

const pendingGrantTransferSchema = z
  .object({
    version: z.literal(1),
    disposition: z.literal('awaiting-grant-install'),
    waitingFor: z.literal('grant-install-or-host-retirement'),
    exit: z.literal('provider-host-grant-install-retry'),
    attemptId: z.string().min(1),
    successorBuildSetId: z.string().min(1),
    incumbentBuildSetId: z.string().min(1),
    grantId: z.string().min(1),
    setKey: z.string().min(1),
  })
  .passthrough();

type PendingGrantTransfer = z.infer<typeof pendingGrantTransferSchema>;
const unconfirmed = {
  kind: 'unconfirmed',
  disposition: 'held',
  waitingFor: 'durable-status-write',
  exit: 'provider-set-inheritance-retry',
} as const;

function statusPath(runtime: Runtime, capsule: RedeemableHandoffCapsule): string {
  const setKey = providerProxySetKey(providerProxySetIdentityFromCapsule(capsule));
  return join(runtime.paths.coral.coordinator.runDir, `provider-grant-transfer-${runtime.ids.sha256(setKey)}.json`);
}

/** An unreadable status cannot decide that the host belongs to another controller. */
export function readPendingGrantTransfer(
  runtime: Runtime,
  capsule: RedeemableHandoffCapsule,
  successorBuildSetId: string,
):
  | Readonly<{ kind: 'absent' }>
  | Readonly<{
      kind: 'unreadable';
      disposition: 'held';
      waitingFor: 'durable-status-read';
      exit: 'provider-set-inheritance-retry';
    }>
  | Readonly<{
      kind: 'recorded';
      attemptId: string;
      disposition: 'awaiting-grant-install';
      waitingFor: 'grant-install-or-host-retirement';
      exit: 'provider-host-grant-install-retry';
    }> {
  const path = statusPath(runtime, capsule);
  const unreadable = {
    kind: 'unreadable',
    disposition: 'held',
    waitingFor: 'durable-status-read',
    exit: 'provider-set-inheritance-retry',
  } as const;
  try {
    if (!runtime.storage.existsSync(path)) return { kind: 'absent' };
    const parsed = pendingGrantTransferSchema.safeParse(JSON.parse(runtime.storage.readFileSync(path, 'utf-8')));
    if (!parsed.success) return unreadable;
    const status = parsed.data;
    return status.setKey === providerProxySetKey(providerProxySetIdentityFromCapsule(capsule)) &&
      status.incumbentBuildSetId === handoffCapsuleControllerBuildSetId(capsule) &&
      status.grantId === capsule.grantId &&
      status.successorBuildSetId === successorBuildSetId
      ? {
          kind: 'recorded',
          attemptId: status.attemptId,
          disposition: status.disposition,
          waitingFor: status.waitingFor,
          exit: status.exit,
        }
      : { kind: 'absent' };
  } catch {
    return unreadable;
  }
}

/** A transfer cannot be accepted until its restart evidence is durable. */
export function recordPendingGrantTransfer(
  runtime: Runtime,
  capsule: RedeemableHandoffCapsule,
  successorBuildSetId: string,
  attemptId: string,
): Readonly<{ kind: 'recorded' } | typeof unconfirmed> {
  const current = readPendingGrantTransfer(runtime, capsule, successorBuildSetId);
  if (current.kind === 'recorded' && current.attemptId === attemptId) return { kind: 'recorded' };
  if (current.kind === 'unreadable') return unconfirmed;
  const status: PendingGrantTransfer = {
    version: 1,
    disposition: 'awaiting-grant-install',
    waitingFor: 'grant-install-or-host-retirement',
    exit: 'provider-host-grant-install-retry',
    attemptId,
    successorBuildSetId,
    incumbentBuildSetId: handoffCapsuleControllerBuildSetId(capsule),
    grantId: capsule.grantId,
    setKey: providerProxySetKey(providerProxySetIdentityFromCapsule(capsule)),
  };
  try {
    runtime.storage.mkdirSync(runtime.paths.coral.coordinator.runDir, { recursive: true, mode: 0o700 });
    const written = runtime.storage.writeAtomicDurableSync(
      statusPath(runtime, capsule),
      `${JSON.stringify(status)}\n`,
      {
        encoding: 'utf-8',
        mode: 0o600,
      },
    );
    return written ? { kind: 'recorded' } : unconfirmed;
  } catch {
    return unconfirmed;
  }
}
