import type { ShutdownObligation } from '../shutdown-settlement.js';
import type { JsonValue } from '../../infra/json-value.js';
import type { SuccessionCapabilities } from './protocol.js';

export type SuccessionOwnerId = ShutdownObligation['label'];

export const REQUIRED_SUCCESSION_OWNERS = [
  'launch-admission',
  'durable-cli',
  'provider-operations',
  'provider-proxy-sets',
  'provider-hosts',
  'recovery',
  'workflow',
  'kb-daemon',
  'discuss',
  'session-continuation',
  'child-principals',
] as const satisfies readonly SuccessionOwnerId[];

export type TransferReceipt = Readonly<{
  owner: SuccessionOwnerId;
  generation: number;
  attemptId: string;
  receiptId: string;
  recoveryGrantId: string;
  payload: JsonValue;
}>;

export type OwnerDisposition =
  | Readonly<{ kind: 'completed'; reason: string }>
  | Readonly<{ kind: 'blocking'; reason: string }>
  | Readonly<{ kind: 'transferable'; reason: string; receipt: TransferReceipt }>;

export type SuccessionOwner = Readonly<{
  id: SuccessionOwnerId;
  /** A transferable result requires its attempt-scoped recovery grant to be durable before return. */
  classify: (attemptId: string, capabilities: SuccessionCapabilities) => Promise<OwnerDisposition>;
}>;

export type ObligationPreparation =
  | Readonly<{ kind: 'prepared'; receipts: readonly TransferReceipt[] }>
  | Readonly<{ kind: 'blocking'; blockers: readonly { owner: SuccessionOwnerId; reason: string }[] }>;

/** An undeclared owner or contract generation cannot authorize a transfer. */
export async function prepareOwnerObligations(
  owners: readonly SuccessionOwner[],
  attemptId: string,
  capabilities: SuccessionCapabilities,
  requiredOwners: readonly SuccessionOwnerId[] = REQUIRED_SUCCESSION_OWNERS,
): Promise<ObligationPreparation> {
  const blockers: { owner: SuccessionOwnerId; reason: string }[] = [];
  const receipts: TransferReceipt[] = [];
  const receiptIds = new Set<string>();
  const seen = new Set<SuccessionOwnerId>();
  for (const owner of owners) {
    if (seen.has(owner.id)) {
      blockers.push({ owner: owner.id, reason: 'duplicate owner disposition' });
      continue;
    }
    seen.add(owner.id);
    if (!capabilities.accepts.some((entry) => entry.owner === owner.id)) {
      blockers.push({ owner: owner.id, reason: 'target does not declare this owner contract' });
      continue;
    }
    try {
      const disposition = await owner.classify(attemptId, capabilities);
      if (disposition.reason.trim().length === 0) {
        blockers.push({ owner: owner.id, reason: 'owner disposition has no reason' });
      } else if (disposition.kind === 'blocking') {
        blockers.push({ owner: owner.id, reason: disposition.reason });
      } else if (disposition.kind === 'transferable') {
        const receipt = disposition.receipt;
        const accepted = capabilities.accepts.some(
          (entry) => entry.owner === owner.id && entry.generation === receipt.generation,
        );
        if (
          !accepted ||
          receipt.owner !== owner.id ||
          receipt.attemptId !== attemptId ||
          receipt.receiptId.length === 0 ||
          receipt.recoveryGrantId.length === 0 ||
          receiptIds.has(receipt.receiptId)
        ) {
          blockers.push({ owner: owner.id, reason: 'transfer receipt or recovery grant does not match the attempt' });
        } else {
          receiptIds.add(receipt.receiptId);
          receipts.push(receipt);
        }
      }
    } catch {
      blockers.push({ owner: owner.id, reason: 'owner disposition unavailable' });
    }
  }
  for (const owner of requiredOwners) {
    if (!seen.has(owner)) blockers.push({ owner, reason: 'owner disposition unavailable' });
  }
  return blockers.length > 0 ? { kind: 'blocking', blockers } : { kind: 'prepared', receipts };
}
