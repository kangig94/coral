import type { ShutdownObligation } from '../shutdown-settlement.js';
import type { JsonValue } from '../../infra/json-value.js';
import type { SuccessionCapabilities } from './protocol.js';

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
] as const;

export type SuccessionOwnerId = (typeof REQUIRED_SUCCESSION_OWNERS)[number];
type SuccessionBlockerOwner = SuccessionOwnerId | 'jobs';

type ShutdownObligationRegistryKey =
  | Exclude<
      ShutdownObligation['label'],
      `stream response close ${number}` | `provider proxy lifecycle fatal incident${'' | ` ${number}`}`
    >
  | 'stream response close'
  | 'provider proxy lifecycle fatal incident';

export const SHUTDOWN_OBLIGATION_OWNERS = {
  'inflight drain': 'launch-admission',
  'server connection close': 'session-continuation',
  'stream response close': 'session-continuation',
  'server close': 'session-continuation',
  'recovery coordinator teardown': 'recovery',
  'ownership checker teardown': 'recovery',
  'kb child shutdown': 'kb-daemon',
  'provider operation mutation drain': 'provider-operations',
  'store services availability check': 'recovery',
  'provider host shutdown': 'provider-hosts',
  'pending launch settlement': 'launch-admission',
  'child termination': 'launch-admission',
  'crashed job terminalization': 'recovery',
  'app-server handoff quiesce': 'provider-hosts',
  'provider host drain for handoff': 'provider-hosts',
  'components disposeAll': 'recovery',
  'hooks.onShutdown': 'workflow',
  'discuss store dispose': 'discuss',
  'process incarnation probe shutdown': 'recovery',
  'lifecycle reactor dispose': 'recovery',
  'store epoch sweep cancellation': 'recovery',
  'succession attempt settlement': 'recovery',
  'succession connection handover': 'session-continuation',
  'provider proxy lifecycle fatal incident': 'provider-proxy-sets',
} as const satisfies Record<ShutdownObligationRegistryKey, SuccessionOwnerId>;

export type TransferReceipt = Readonly<{
  owner: SuccessionOwnerId;
  generation: number;
  attemptId: string;
  receiptId: string;
  recoveryGrantId: string;
  payload: JsonValue;
}>;

export type OwnerDisposition =
  | Readonly<{ kind: 'completed'; reason: string; jobIds?: readonly string[] }>
  | Readonly<{ kind: 'blocking'; reason: string; jobIds?: readonly string[] }>
  | Readonly<{ kind: 'transferable'; reason: string; receipt: TransferReceipt; jobIds?: readonly string[] }>;

export type SuccessionOwner = Readonly<{
  id: SuccessionOwnerId;
  /**
   * A transferable result requires its attempt-scoped recovery grant to be durable before return. An owner the
   * target cannot accept is classified again for the same attempt inside its commit window, before writers park.
   */
  classify: (attemptId: string, capabilities: SuccessionCapabilities) => Promise<OwnerDisposition>;

  recordsGrants?: true;

  inspectBlocker?: (capabilities: SuccessionCapabilities) => string | null;

  dischargeGrants?: (retained: ReadonlySet<string>) => void;
}>;

export type ObligationPreparation =
  | Readonly<{ kind: 'prepared'; receipts: readonly TransferReceipt[] }>
  | Readonly<{ kind: 'blocking'; blockers: readonly { owner: SuccessionBlockerOwner; reason: string }[] }>;

export function certifySuccessionJobCoverage(
  liveJobIds: readonly string[],
  claims: ReadonlyMap<string, readonly string[]>,
): readonly string[] {
  const failures: string[] = [];
  for (const jobId of new Set([...liveJobIds, ...claims.keys()])) {
    const owners = claims.get(jobId) ?? [];
    if (owners.length === 0) failures.push(`unclaimed: ${jobId}`);
    else if (owners.length !== 1) failures.push(`multiply claimed: ${jobId}`);
  }
  return failures;
}

export async function prepareOwnerObligations(
  owners: readonly SuccessionOwner[],
  attemptId: string,
  capabilities: SuccessionCapabilities,
  requiredOwners: readonly SuccessionOwnerId[] = REQUIRED_SUCCESSION_OWNERS,
  liveJobIds: () => readonly string[] = () => [],
): Promise<ObligationPreparation> {
  const blockers: { owner: SuccessionBlockerOwner; reason: string }[] = [];
  const receipts: TransferReceipt[] = [];
  const receiptIds = new Set<string>();
  const seen = new Set<SuccessionOwnerId>();
  const claims = new Map<string, SuccessionOwnerId[]>();
  const ordered = [
    ...owners.filter((owner) => owner.recordsGrants !== true),
    ...owners.filter((owner) => owner.recordsGrants === true),
  ];
  const unavailable = requiredOwners.filter((required) => !owners.some((owner) => owner.id === required));
  let classifiedEvery = true;
  for (const owner of ordered) {
    if (owner.recordsGrants === true && (blockers.length > 0 || unavailable.length > 0)) {
      classifiedEvery = false;
      try {
        const reason = owner.inspectBlocker?.(capabilities);
        if (reason) blockers.push({ owner: owner.id, reason });
      } catch {
        blockers.push({ owner: owner.id, reason: 'owner disposition unavailable' });
      }
      continue;
    }
    if (seen.has(owner.id)) {
      blockers.push({ owner: owner.id, reason: 'duplicate owner disposition' });
      continue;
    }
    seen.add(owner.id);
    try {
      const disposition = await owner.classify(attemptId, capabilities);
      for (const jobId of new Set(disposition.jobIds ?? [])) {
        const ownersForJob = claims.get(jobId) ?? [];
        ownersForJob.push(owner.id);
        claims.set(jobId, ownersForJob);
      }
      if (disposition.kind === 'completed' && (disposition.jobIds?.length ?? 0) > 0) {
        blockers.push({ owner: owner.id, reason: 'completed owner still claims live jobs' });
      } else if (disposition.reason.trim().length === 0) {
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
  for (const owner of unavailable) blockers.push({ owner, reason: 'owner disposition unavailable' });
  if (!classifiedEvery) return { kind: 'blocking', blockers };
  try {
    for (const reason of certifySuccessionJobCoverage(liveJobIds(), claims)) {
      blockers.push({ owner: 'jobs', reason });
    }
  } catch {
    blockers.push({ owner: 'jobs', reason: 'live job coverage unavailable' });
  }
  return blockers.length > 0 ? { kind: 'blocking', blockers } : { kind: 'prepared', receipts };
}

/**
 * An owner the target cannot accept can only complete or block, and no receipt carries its work; one that no longer
 * completes holds an obligation that began after preparation and would otherwise be abandoned when writers park.
 */
export function recertifyUntransferableOwners(
  owners: readonly SuccessionOwner[],
  attemptId: string,
  capabilities: SuccessionCapabilities,
  requiredOwners: readonly SuccessionOwnerId[] = REQUIRED_SUCCESSION_OWNERS,
): Promise<ObligationPreparation> {
  const accepted = new Set(capabilities.accepts.map((entry) => entry.owner));
  return prepareOwnerObligations(
    owners.filter((owner) => !accepted.has(owner.id)),
    attemptId,
    capabilities,
    requiredOwners.filter((owner) => !accepted.has(owner)),
  );
}
