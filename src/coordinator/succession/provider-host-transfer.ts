import { formatError } from '../../infra/error-format.js';
import type { JsonValue } from '../../infra/json-value.js';
import { readUpgradeIntent, type UpgradeIntent } from '../../infra/upgrade-intent.js';
import { PROVIDER_PROXY_CONTROL_GENERATION } from '../../provider-proxy/controller-succession.js';
import { PROXY_CONTROL_RPC_TIMEOUT_MS } from '../../provider-proxy/protocol.js';
import type { RedeemableHandoffCapsule } from '../../provider-proxy/handoff-capsule.js';
import type { ControllerTransferAcceptance } from '../services/provider-proxy-set/inheritance.js';
import type { Runtime } from '../../runtime/ports.js';
import type { Database } from '../../store/db.js';
import { readProviderOperation, readProviderOperations } from '../../store/provider-operation-journal.js';
import { observeSuccessionServing } from '../../store/succession-writer-generation.js';
import {
  PROVIDER_OPERATIONS_TRANSFER_GENERATION,
  controllerTransferHandsCapsuleTo,
  controllerTransferRecoveryGrantId,
  controllerTransferRecoveryGrantsVerify,
  decodeProviderOperationTransfer,
  decodeProviderProxyControllerTransfer,
  encodeProviderOperationTransfer,
  encodeProviderProxyControllerTransfer,
  providerOperationPhaseTransfers,
  transferredOperation,
  transferredSetOf,
  verifyProviderOperationTransfer,
  type ProviderProxyControllerTransfer,
  type TransferredProviderProxySet,
} from '../services/provider-proxy-set/controller-transfer.js';
import {
  providerProxySetIdentitiesEqual,
  providerProxySetIdentityFromRecord,
  type ProviderProxySetIdentity,
} from '../services/provider-proxy-set/identity.js';
import {
  readPendingGrantTransfer,
  recordPendingGrantTransfer,
} from '../services/provider-proxy-set/pending-grant-transfer.js';
import type { ProviderProxySetLifecycle } from '../services/provider-proxy-set/index.js';
import type { OwnerDisposition, SuccessionOwner } from './obligations.js';
import { successionPreparationSchema, type SuccessionCapabilities, type SuccessionPreparation } from './protocol.js';

export const PROVIDER_PROXY_SETS_OWNER = 'provider-proxy-sets';
export const PROVIDER_OPERATIONS_OWNER = 'provider-operations';

const INSTALL_RETRY_BASE_MS = 1_000;
const INSTALL_RETRY_MAX_MS = 30_000;

export type ProviderHostTransferPorts = Readonly<{
  runtime: Runtime;
  flavor: 'prod' | 'dev';
  /** This coordinator's own build, which is the controller build of every set it serves. */
  buildSetId: string;
  lifecycle: () => ProviderProxySetLifecycle | null;
  db: () => Database;
  /** Whether a job already reached its terminal, so no host is left to take over for it. */
  jobSettled: (jobId: string) => boolean;
  /** Jobs with an in-process operation this coordinator is still driving. */
  localOperationJobIds: () => readonly string[];
  /** A host that keeps running after its install is replaced must run from a root that outlives it. */
  hostRootRetained: (buildSetId: string) => boolean;
  /** The attempt this process runs as the successor of, when it is one. */
  attemptId: () => string | null;
  /** Hosts move only with the exact epoch their saga rows live in, which a successor of another format cannot open. */
  targetChangesStoreFormat: () => boolean;
  log: (message: string) => void;
}>;

type HostTransferPreparation =
  | Readonly<{ kind: 'none' }>
  | Readonly<{ kind: 'blocking'; reason: string; jobIds: readonly string[] }>
  | Readonly<{
      kind: 'transferable';
      sets: TransferredProviderProxySet[];
      operations: ReturnType<typeof transferredOperation>[];
      jobIds: readonly string[];
      recoveryGrantId: string;
      successorBuildSetId: string;
    }>;

function accepts(capabilities: SuccessionCapabilities, owner: string, generation: number): boolean {
  return capabilities.accepts.some((entry) => entry.owner === owner && entry.generation === generation);
}

function namesTransferredSet(identity: ProviderProxySetIdentity, set: TransferredProviderProxySet): boolean {
  return (
    identity.buildSetId === set.buildSetId &&
    identity.hostFingerprint === set.hostFingerprint &&
    identity.proxyInstanceId === set.proxyInstanceId &&
    identity.guardianInstanceId === set.guardianInstanceId &&
    identity.reaperInstanceId === set.reaperInstanceId
  );
}

function receiptOf(
  preparation: SuccessionPreparation,
  owner: string,
): SuccessionPreparation['receipts'][number] | null {
  return preparation.receipts.find((receipt) => receipt.owner === owner) ?? null;
}

function completedTransferServed(
  intent: UpgradeIntent,
  attemptId: string,
  receiptId: string,
  ownBuildSetId: string,
): boolean {
  return (
    intent.disposition === 'completed' &&
    intent.attemptId === attemptId &&
    intent.completionReceipt?.attemptId === attemptId &&
    intent.completionReceipt.successor.build.buildSetId === ownBuildSetId &&
    intent.completionReceipt.acceptedObligations.some(
      (obligation) => obligation.owner === PROVIDER_PROXY_SETS_OWNER && obligation.receiptId === receiptId,
    )
  );
}

/** A pre-serving transfer is valid only for its running attempt; a later controller needs durable serving evidence. */
export function acceptedControllerTransferHandsCapsule(
  runtime: Runtime,
  ownBuildSetId: string,
  runningAttemptId: string | null,
  capsule: RedeemableHandoffCapsule,
): ControllerTransferAcceptance {
  const observed = readUpgradeIntent(runtime.paths.coral.coordinator.runDir);
  if (observed.kind === 'readable') {
    const preparation = successionPreparationSchema.safeParse(observed.intent.successionPreparation);
    if (preparation.success) {
      const receipt = receiptOf(preparation.data, PROVIDER_PROXY_SETS_OWNER);
      const transfer = receipt === null ? null : decodeProviderProxyControllerTransfer(receipt.payload);
      if (receipt !== null && transfer !== null && controllerTransferHandsCapsuleTo(transfer, capsule, ownBuildSetId)) {
        const attemptId = preparation.data.attemptId;
        const served =
          observeSuccessionServing(runtime, attemptId) !== null ||
          completedTransferServed(observed.intent, attemptId, receipt.receiptId, ownBuildSetId);
        if (!served && runningAttemptId !== attemptId) return 'not-accepted';
        if (recordPendingGrantTransfer(runtime, capsule, ownBuildSetId, attemptId).kind !== 'recorded') {
          return 'unconfirmed';
        }
        return served ? 'served' : 'before-serving';
      }
    }
  }
  const pending = readPendingGrantTransfer(runtime, capsule, ownBuildSetId);
  if (pending.kind === 'unreadable') return 'unconfirmed';
  if (pending.kind !== 'recorded') return 'not-accepted';
  return observeSuccessionServing(runtime, pending.attemptId) !== null ||
    (observed.kind === 'readable' &&
      completedTransferServed(
        observed.intent,
        pending.attemptId,
        `${PROVIDER_PROXY_SETS_OWNER}:${pending.attemptId}`,
        ownBuildSetId,
      ))
    ? 'served'
    : 'not-accepted';
}

/**
 * Whether a provider host receipt of `preparation` still has the recovery grant a failed attempt's recovery
 * redeems: each set's capsule must hold the recorded grant under the incumbent's controller build.
 */
export function providerHostRecoveryGrantVerifies(
  runtime: Runtime,
  flavor: 'prod' | 'dev',
  preparation: SuccessionPreparation,
  receipt: SuccessionPreparation['receipts'][number],
): boolean {
  const setsReceipt = receiptOf(preparation, PROVIDER_PROXY_SETS_OWNER);
  const transfer = setsReceipt === null ? null : decodeProviderProxyControllerTransfer(setsReceipt.payload);
  if (transfer === null || setsReceipt === null || receipt.recoveryGrantId !== setsReceipt.recoveryGrantId) {
    return false;
  }
  if (receipt.owner === PROVIDER_OPERATIONS_OWNER) return decodeProviderOperationTransfer(receipt.payload) !== null;
  return (
    receipt.owner === PROVIDER_PROXY_SETS_OWNER &&
    controllerTransferRecoveryGrantsVerify(runtime, flavor, transfer, receipt.recoveryGrantId, false)
  );
}

/** Transferred hosts must keep recoverable custody until their provider operations settle. */
export function createProviderHostTransfer(ports: ProviderHostTransferPorts): Readonly<{
  owners: readonly [SuccessionOwner, SuccessionOwner];
  releaseForTransfer(attemptId: string, signal: AbortSignal): Promise<void>;
  reclaimTransferred(): void;
  transfersHosts(preparation: SuccessionPreparation): boolean;
  verifyReceipts(preparation: SuccessionPreparation, committedSuccessorServed?: boolean): readonly string[];
  adoptReceipts(preparation: SuccessionPreparation): void;
  /** The jobs a `provider-operations` receipt names, without re-reading the journal they may have moved on in. */
  transferredJobIds(preparation: SuccessionPreparation): readonly string[];
  completeTransfers(): Promise<void>;
}> {
  let prepared: Readonly<{ attemptId: string; preparation: Promise<HostTransferPreparation> }> | null = null;

  const prepare = (attemptId: string, capabilities: SuccessionCapabilities): Promise<HostTransferPreparation> => {
    if (prepared?.attemptId !== attemptId) {
      prepared = { attemptId, preparation: prepareTransfer(attemptId, capabilities) };
    }
    return prepared.preparation;
  };

  async function prepareTransfer(
    attemptId: string,
    capabilities: SuccessionCapabilities,
  ): Promise<HostTransferPreparation> {
    const lifecycle = ports.lifecycle();
    const sets = lifecycle?.liveSets() ?? [];
    const scan = readProviderOperations(ports.db());
    const jobIds = [
      ...new Set([...scan.records.map((record) => record.operation.jobId), ...ports.localOperationJobIds()]),
    ];
    if (sets.length === 0 && jobIds.length === 0 && scan.unreadableKeys.length === 0) return { kind: 'none' };
    const blocking = (reason: string): HostTransferPreparation => ({ kind: 'blocking', reason, jobIds });
    if (lifecycle === null) return blocking('provider proxy set lifecycle is unavailable');
    // Idle capacity carries no obligation, so a set the successor cannot take is retired rather than held, and
    // its retirement is the obligation change that lets a later attempt proceed.
    const untransferable = (reason: string): HostTransferPreparation => {
      if (jobIds.length > 0 || scan.unreadableKeys.length > 0) return blocking(reason);
      for (const set of sets) lifecycle.beginGracefulDrain(set.setIdentity);
      return blocking(`idle provider proxy set is retiring before succession: ${reason}`);
    };
    if (ports.targetChangesStoreFormat()) return untransferable('successor changes the store format');
    if (!accepts(capabilities, PROVIDER_PROXY_SETS_OWNER, PROVIDER_PROXY_CONTROL_GENERATION)) {
      return untransferable(`successor does not accept host control generation ${PROVIDER_PROXY_CONTROL_GENERATION}`);
    }
    if (
      jobIds.length > 0 &&
      !accepts(capabilities, PROVIDER_OPERATIONS_OWNER, PROVIDER_OPERATIONS_TRANSFER_GENERATION)
    ) {
      return blocking(
        `successor does not accept provider operation generation ${PROVIDER_OPERATIONS_TRANSFER_GENERATION}`,
      );
    }
    if (scan.unreadableKeys.length > 0) return blocking('a provider operation record is unreadable');
    const recordedJobs = new Set(scan.records.map((record) => record.operation.jobId));
    if (ports.localOperationJobIds().some((jobId) => !recordedJobs.has(jobId))) {
      return blocking('a provider operation runs without a durable saga record');
    }
    for (const record of scan.records) {
      if (!providerOperationPhaseTransfers(record.phase)) {
        return blocking(`provider operation for job ${record.operation.jobId} is ${record.phase}`);
      }
      if (lifecycle.authorityFor(providerProxySetIdentityFromRecord(record)) === null) {
        return blocking(`provider operation for job ${record.operation.jobId} has no serving host`);
      }
    }
    for (const set of sets) {
      if (lifecycle.authorityFor(set.setIdentity) !== set) {
        return blocking('a provider proxy set is not under operational control');
      }
      if (!ports.hostRootRetained(set.setIdentity.buildSetId)) {
        return untransferable('a provider host runs from a plugin root that is not retained');
      }
    }
    const successor = { generation: 'gen2' as const, flavor: ports.flavor, buildSetId: capabilities.buildSetId };
    const signal = AbortSignal.timeout(PROXY_CONTROL_RPC_TIMEOUT_MS * 2);
    const transferred: TransferredProviderProxySet[] = [];
    for (const set of sets) {
      const outcome = await set.authorizeControllerTransfer({ attemptId, successor }, signal);
      switch (outcome.kind) {
        case 'authorized':
          transferred.push(transferredSetOf(set.setIdentity, outcome.recoveryGrantId));
          break;
        case 'legacy-host':
          return untransferable(`provider ${outcome.role} predates controller succession`);
        case 'refused':
          return blocking(`provider ${outcome.incident.role} refused controller transfer`);
        case 'retryable':
          return blocking(`provider ${outcome.incident.role} did not acknowledge controller transfer`);
        case 'cancelled':
          return blocking('controller transfer authorization timed out');
      }
    }
    return {
      kind: 'transferable',
      sets: transferred,
      operations: scan.records.map((record) => transferredOperation(record.operation, record.locator.hostFingerprint)),
      jobIds,
      recoveryGrantId: controllerTransferRecoveryGrantId(transferred, (value) => ports.runtime.ids.sha256(value)),
      successorBuildSetId: capabilities.buildSetId,
    };
  }

  const toJson = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue;

  /** A same-build recovery redeems through the grant its incumbent's build still holds, never through the takeover. */
  const receiptReader = (transfer: ProviderProxyControllerTransfer): 'successor' | 'recovery' | null =>
    transfer.successorBuildSetId === ports.buildSetId
      ? 'successor'
      : transfer.incumbentBuildSetId === ports.buildSetId
        ? 'recovery'
        : null;

  const awaitBeforeAbort = <T>(pending: Promise<T>, signal: AbortSignal): Promise<T> =>
    new Promise((resolve, reject) => {
      const asError = (reason: unknown): Error => (reason instanceof Error ? reason : new Error(formatError(reason)));
      if (signal.aborted) return reject(asError(signal.reason));
      const abort = () => reject(asError(signal.reason));
      signal.addEventListener('abort', abort, { once: true });
      pending.then(
        (value) => {
          signal.removeEventListener('abort', abort);
          resolve(value);
        },
        (error: unknown) => {
          signal.removeEventListener('abort', abort);
          reject(asError(error));
        },
      );
    });

  /** A grant reinstalled after preparation revokes the transfer; only authorization at release admits the successor. */
  async function reauthorizeTransfer(
    lifecycle: ProviderProxySetLifecycle,
    attemptId: string,
    transfer: Extract<HostTransferPreparation, { kind: 'transferable' }>,
    signal: AbortSignal,
  ): Promise<void> {
    const successor = { generation: 'gen2' as const, flavor: ports.flavor, buildSetId: transfer.successorBuildSetId };
    await Promise.all(
      transfer.sets.map(async (transferred) => {
        const set = lifecycle.liveSets().find((candidate) => namesTransferredSet(candidate.setIdentity, transferred));
        if (set === undefined || lifecycle.authorityFor(set.setIdentity) !== set) {
          throw new Error('An authorized provider host is not under operational control at release.');
        }
        const outcome = await awaitBeforeAbort(
          set.authorizeControllerTransfer({ attemptId, successor }, signal),
          signal,
        );
        if (outcome.kind !== 'authorized' || outcome.recoveryGrantId !== transferred.recoveryGrantId) {
          throw new Error(`Provider host no longer authorizes the prepared successor: ${outcome.kind}.`);
        }
      }),
    );
  }

  async function completeTransfer(identity: ProviderProxySetIdentity): Promise<void> {
    let delayMs = INSTALL_RETRY_BASE_MS;
    let reported: string | null = null;
    for (;;) {
      const set = ports
        .lifecycle()
        ?.liveSets()
        .find((candidate) => providerProxySetIdentitiesEqual(candidate.setIdentity, identity));
      if (set === undefined) return;
      let pending: string;
      try {
        const installed = await set.installRecoveryCredential(AbortSignal.timeout(PROXY_CONTROL_RPC_TIMEOUT_MS * 2));
        if (installed.kind === 'installed') return;
        if (
          installed.kind === 'retryable' &&
          installed.incident.exchange.kind === 'not-sent' &&
          installed.incident.exchange.cause === 'connection-already-closed'
        ) {
          ports.log("Provider host control closed before its recovery grant became this controller's.\n");
          return;
        }
        pending = installed.kind === 'refused' ? `refused by ${installed.incident.role}` : installed.kind;
      } catch (error: unknown) {
        pending = formatError(error);
      }
      if (pending !== reported) {
        ports.log(`Provider host recovery grant is not yet this controller's (${pending}); retrying.\n`);
        reported = pending;
      }
      await ports.runtime.time.sleep(delayMs);
      delayMs = Math.min(delayMs * 2, INSTALL_RETRY_MAX_MS);
    }
  }

  const operationsOwner: SuccessionOwner = {
    id: PROVIDER_OPERATIONS_OWNER,
    recordsGrants: true,
    classify: async (attemptId, capabilities): Promise<OwnerDisposition> => {
      const transfer = await prepare(attemptId, capabilities);
      if (transfer.kind === 'blocking') return { kind: 'blocking', reason: transfer.reason, jobIds: transfer.jobIds };
      if (transfer.kind === 'none' || transfer.operations.length === 0) {
        return { kind: 'completed', reason: 'no provider operation custody' };
      }
      return {
        kind: 'transferable',
        reason: 'provider operations run in hosts that accepted the successor',
        jobIds: transfer.jobIds,
        receipt: {
          owner: PROVIDER_OPERATIONS_OWNER,
          generation: PROVIDER_OPERATIONS_TRANSFER_GENERATION,
          attemptId,
          receiptId: `${PROVIDER_OPERATIONS_OWNER}:${attemptId}`,
          recoveryGrantId: transfer.recoveryGrantId,
          payload: toJson(encodeProviderOperationTransfer({ version: 1, operations: transfer.operations })),
        },
      };
    },
  };

  const setsOwner: SuccessionOwner = {
    id: PROVIDER_PROXY_SETS_OWNER,
    recordsGrants: true,
    inspectBlocker: (capabilities) => {
      const sets = ports.lifecycle()?.liveSets() ?? [];
      const scan = readProviderOperations(ports.db());
      if (
        sets.length === 0 &&
        scan.records.length === 0 &&
        scan.unreadableKeys.length === 0 &&
        ports.localOperationJobIds().length === 0
      )
        return null;
      if (ports.targetChangesStoreFormat()) return 'successor changes the store format';
      return accepts(capabilities, PROVIDER_PROXY_SETS_OWNER, PROVIDER_PROXY_CONTROL_GENERATION)
        ? null
        : `successor does not accept host control generation ${PROVIDER_PROXY_CONTROL_GENERATION}`;
    },
    classify: async (attemptId, capabilities): Promise<OwnerDisposition> => {
      const transfer = await prepare(attemptId, capabilities);
      if (transfer.kind === 'blocking') return { kind: 'blocking', reason: transfer.reason };
      if (transfer.kind === 'none' || transfer.sets.length === 0) {
        return { kind: 'completed', reason: 'no live provider proxy set' };
      }
      return {
        kind: 'transferable',
        reason: 'every provider host authorized the successor and keeps a recovery grant',
        receipt: {
          owner: PROVIDER_PROXY_SETS_OWNER,
          generation: PROVIDER_PROXY_CONTROL_GENERATION,
          attemptId,
          receiptId: `${PROVIDER_PROXY_SETS_OWNER}:${attemptId}`,
          recoveryGrantId: transfer.recoveryGrantId,
          payload: toJson(
            encodeProviderProxyControllerTransfer({
              version: 1,
              controlGeneration: PROVIDER_PROXY_CONTROL_GENERATION,
              incumbentBuildSetId: ports.buildSetId,
              successorBuildSetId: transfer.successorBuildSetId,
              sets: transfer.sets,
            }),
          ),
        },
      };
    },
  };

  return {
    owners: [operationsOwner, setsOwner],
    releaseForTransfer: async (attemptId, signal) => {
      const lifecycle = ports.lifecycle();
      if (lifecycle === null) throw new Error('Provider proxy set lifecycle is unavailable at host release.');
      const transfer = prepared?.attemptId === attemptId ? await awaitBeforeAbort(prepared.preparation, signal) : null;
      if (transfer?.kind !== 'transferable') {
        throw new Error('Provider host transfer was not prepared for this attempt.');
      }
      await reauthorizeTransfer(lifecycle, attemptId, transfer, signal);
      signal.throwIfAborted();
      const released = await awaitBeforeAbort(lifecycle.releaseControlForTransfer(attemptId), signal);
      const unreleased = transfer.sets.filter(
        (set) => !released.some((identity) => namesTransferredSet(identity, set)),
      );
      if (unreleased.length > 0) {
        throw new Error(`${unreleased.length} authorized provider host(s) were not released for the successor.`);
      }
    },
    reclaimTransferred: () => {
      ports.lifecycle()?.reclaimTransferredControl();
    },
    transfersHosts: (preparation) => receiptOf(preparation, PROVIDER_PROXY_SETS_OWNER) !== null,
    verifyReceipts: (preparation, committedSuccessorServed = false) => {
      const setsReceipt = receiptOf(preparation, PROVIDER_PROXY_SETS_OWNER);
      const operationsReceipt = receiptOf(preparation, PROVIDER_OPERATIONS_OWNER);
      if (setsReceipt === null) {
        if (operationsReceipt !== null) throw new Error('Provider operation receipt names no host transfer.');
        return [];
      }
      const transfer = decodeProviderProxyControllerTransfer(setsReceipt.payload);
      const reader = transfer === null ? null : receiptReader(transfer);
      if (transfer === null || reader === null) {
        throw new Error('Provider host transfer receipt does not name this successor.');
      }
      const operations = operationsReceipt === null ? null : decodeProviderOperationTransfer(operationsReceipt.payload);
      if (
        operationsReceipt !== null &&
        (operations === null || operationsReceipt.recoveryGrantId !== setsReceipt.recoveryGrantId)
      ) {
        throw new Error('Provider operation receipt no longer matches the saga journal.');
      }
      const unsettledOperations =
        operations === null || !committedSuccessorServed
          ? operations
          : {
              ...operations,
              operations: operations.operations.filter((entry) => !ports.jobSettled(entry.operation.jobId)),
            };
      if (committedSuccessorServed && (operationsReceipt === null || unsettledOperations?.operations.length === 0)) {
        return [];
      }
      const successorServes =
        committedSuccessorServed || observeSuccessionServing(ports.runtime, preparation.attemptId) !== null;
      if (
        !controllerTransferRecoveryGrantsVerify(
          ports.runtime,
          ports.flavor,
          transfer,
          setsReceipt.recoveryGrantId,
          reader === 'successor' && successorServes,
        )
      ) {
        throw new Error('Provider host recovery grants are unavailable or changed.');
      }
      if (operationsReceipt === null) return [];
      const jobIds =
        unsettledOperations === null
          ? null
          : verifyProviderOperationTransfer(
              ports.db(),
              unsettledOperations,
              transfer,
              !committedSuccessorServed && successorServes,
            );
      if (jobIds === null) {
        throw new Error('Provider operation receipt no longer matches the saga journal.');
      }
      return jobIds;
    },
    adoptReceipts: (preparation) => {
      const operationsReceipt = receiptOf(preparation, PROVIDER_OPERATIONS_OWNER);
      if (operationsReceipt === null) return;
      const operations = decodeProviderOperationTransfer(operationsReceipt.payload);
      if (operations === null) throw new Error('Provider operation receipt is invalid.');
      const lifecycle = ports.lifecycle();
      for (const entry of operations.operations) {
        if (ports.jobSettled(entry.operation.jobId)) continue;
        const record = readProviderOperation(ports.db(), entry.operation);
        if (record === null) continue;
        if (lifecycle?.authorityFor(providerProxySetIdentityFromRecord(record)) === null) {
          throw new Error(`Provider host for job ${entry.operation.jobId} was not taken over.`);
        }
      }
    },
    transferredJobIds: (preparation) => {
      const receipt = receiptOf(preparation, PROVIDER_OPERATIONS_OWNER);
      const operations = receipt === null ? null : decodeProviderOperationTransfer(receipt.payload);
      return operations?.operations.map((entry) => entry.operation.jobId) ?? [];
    },
    completeTransfers: async () => {
      const sets = ports.lifecycle()?.liveSets() ?? [];
      await Promise.all(sets.map((set) => completeTransfer(set.setIdentity)));
    },
  };
}
