import { dirname, join } from 'node:path';

import {
  decodeDurableCliProcessRuntimeMeta,
  decodeDurableCliProcessRuntimeMetaV1,
  decodeDurableCliProvisionalProcessRuntimeMeta,
} from '../../../jobs/runtime-meta.js';
import { observeRecordedContainment, reapRecordedContainment } from '../../../infra/process-containment.js';
import { createMonotonicClock } from '../../../infra/monotonic-clock.js';
import { isProcessIncarnation, type ProcessIncarnation } from '../../../infra/node-process.js';
import {
  CONTAINMENT_DISAPPEARANCE_CONFIRM_MS,
  CONTAINMENT_PROCESS_CONTROL_CALL_MAX_MS,
  SIGKILL_GRACE_MS,
  SIGTERM_GRACE_MS,
} from '../../../infra/process-constants.js';
import {
  custodyLedgerDir,
  readCustodyLedger,
  readCustodyLedgerStartMs,
  type CustodyEntry,
} from '../../../store/custody-ledger.js';
import {
  hasEpochCustodyCoverage,
  observeEpochClosure,
  recordEpochClosure,
  setAsideUnreadableEpochClosure,
  type EpochClosureEvidence,
  type EpochClosureRecording,
} from '../../../store/epoch-closure.js';
import {
  knownProtectedEpochAddresses,
  reconcileProtectedEpochs,
  type ProtectedEpochAddress,
} from '../../../store/epoch-protection.js';
import { readOrCreateEpochKey } from '../../../store/epoch-key.js';
import {
  decodeResolvedStoreEpoch,
  lineageJobEpochKey,
  listStoreEpochs,
  type ResolvedStoreEpoch,
} from '../../../store/epoch.js';
import type { Runtime } from '../../../runtime/ports.js';
import type { JobLocationIndex } from '../../../jobs/location-index.js';
import { readUpgradeIntent } from '../../../infra/upgrade-intent.js';
import { successionPreparationSchema } from '../../succession/protocol.js';
import { latestControllerOpen } from '../../succession/controller-open.js';
import { readDurableCliControllerReceipts } from '../durable-cli-transfer.js';

export type ClosureCandidate = Readonly<{ epoch: ResolvedStoreEpoch; epochKey: string; originalPath: string }>;

export function selectProtectedPredecessorFromControllers(
  runtime: Runtime,
  storeRoot: string,
  addresses: readonly ProtectedEpochAddress[],
): string | null {
  const observed: { address: ProtectedEpochAddress; controlGeneration: number }[] = [];
  for (const address of addresses) {
    const controller = latestControllerOpen(runtime, lineageJobEpochKey(storeRoot, address.epochKey));
    if (controller.latest === null || controller.unreadable.length > 0) return null;
    observed.push({ address, controlGeneration: controller.latest.controlGeneration });
  }
  observed.sort((left, right) => right.controlGeneration - left.controlGeneration);
  return observed.length > 1 && observed[0].controlGeneration > observed[1].controlGeneration
    ? observed[0].address.epochKey
    : null;
}
export type CloseProxySet = (
  proxyInstanceId: string,
  guardian: Readonly<{ pid: number; incarnation: ProcessIncarnation }>,
  signal: AbortSignal,
) => Promise<boolean>;
const closureClockScope = Symbol('epoch-closure');
const REAP_DEADLINE_MS =
  SIGTERM_GRACE_MS +
  SIGKILL_GRACE_MS +
  CONTAINMENT_DISAPPEARANCE_CONFIRM_MS +
  2 * CONTAINMENT_PROCESS_CONTROL_CALL_MAX_MS;

/** The current epoch is never a closure candidate, including one a legacy build left without a lineage marker. */
function currentEpochLineageKey(runtime: Runtime): string | undefined {
  const current = listStoreEpochs(runtime).find((entry) => entry.role === 'current');
  if (current === undefined || current.resolved === null) return undefined;
  try {
    return current.epochKey ?? readOrCreateEpochKey(runtime, current.resolved);
  } catch {
    return undefined;
  }
}

/**
 * Epochs no closure may certify: this process's own, the proven current one, which may belong to a successor that is
 * still acquiring effects, and any an unfinished succession names. A closed record never reopens, so certifying an
 * epoch while it can still gain obligations would discharge work that has not happened yet. Null means an unreadable
 * intent may name any epoch, so nothing is certifiable.
 */
export function uncertifiableEpochKeys(
  runtime: Runtime,
  activeEpochKey: string | undefined,
): ReadonlySet<string> | null {
  const keys = new Set<string>();
  if (activeEpochKey !== undefined) keys.add(activeEpochKey);
  const current = currentEpochLineageKey(runtime);
  if (current !== undefined) keys.add(current);
  const observed = readUpgradeIntent(runtime.paths.coral.coordinator.runDir);
  if (observed.kind === 'absent') return keys;
  if (observed.kind !== 'readable') return null;
  const named: string[] = [];
  const discard = observed.intent.unservedMintDiscard;
  if (discard !== null && discard !== undefined) named.push(discard.incumbentEpochKey);
  if (observed.intent.disposition !== 'completed' && observed.intent.disposition !== 'closed') {
    const preparation = successionPreparationSchema.safeParse(observed.intent.successionPreparation);
    if (preparation.success) named.push(preparation.data.epochKey);
  }
  for (const epochKey of named) {
    const lineageKey = decodeResolvedStoreEpoch(runtime, epochKey)?.lineageKey;
    if (lineageKey !== undefined) keys.add(lineageKey);
  }
  return keys;
}

export function closureCandidates(runtime: Runtime): ClosureCandidate[] {
  let storeRoot = runtime.paths.coral.store.dbDir;
  try {
    storeRoot = runtime.storage.realpathSync(storeRoot);
  } catch {
    return [];
  }
  const canonical = listStoreEpochs(runtime).flatMap((entry) => {
    if (entry.role === 'protected' || entry.resolved === null) return [];
    let epochKey: string;
    try {
      epochKey = entry.epochKey ?? readOrCreateEpochKey(runtime, entry.resolved);
    } catch {
      return [];
    }
    return [{ epoch: entry.resolved, originalPath: dirname(entry.resolved.path), epochKey }];
  });
  const protectedEpochs = reconcileProtectedEpochs(runtime, storeRoot).map((address) => ({
    epoch: {
      storeRoot: dirname(address.protectedPath),
      epoch: address.epochKey.slice(address.epochKey.lastIndexOf(':') + 1),
      path: join(address.protectedPath, 'store.db'),
      lineageKey: address.epochKey,
      canonicalStoreRoot: storeRoot,
    },
    originalPath: address.originalPath,
    epochKey: address.epochKey,
  }));
  return [...canonical, ...protectedEpochs];
}

function predatesCustodyCoverage(runtime: Runtime, candidate: ClosureCandidate): boolean {
  const startMs = readCustodyLedgerStartMs(runtime, runtime.paths.coral.coordinator.runDir);
  if (startMs === null) return false;
  try {
    runtime.storage.lstatSync(join(dirname(candidate.epoch.path), '.coral-custody-coverage.v1.json'));
    return false;
  } catch (error: unknown) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) return false;
  }
  try {
    runtime.storage.lstatSync(join(dirname(candidate.epoch.path), '.coral-used-after-custody-start.v1.json'));
    return false;
  } catch (error: unknown) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) return false;
  }
  const epochs = listStoreEpochs(runtime);
  const observed = epochs.find(
    (entry) => entry.epochKey === candidate.epochKey && entry.resolved?.path === candidate.epoch.path,
  );
  return (
    observed?.epochJson.kind === 'valid' &&
    Date.parse(observed.epochJson.value.publishedAt) < startMs &&
    epochs.some(
      (entry) =>
        entry.resolved?.storeRoot === candidate.epoch.storeRoot &&
        entry.epochJson.kind === 'valid' &&
        BigInt(entry.epoch) > BigInt(candidate.epoch.epoch) &&
        Date.parse(entry.epochJson.value.publishedAt) < startMs,
    )
  );
}

function observePreCoverageCustody(
  runtime: Runtime,
  candidate: ClosureCandidate,
  entries: readonly CustodyEntry[],
  ambiguousOriginalPath: boolean,
): Readonly<{ kind: 'alive' | 'undecidable' | 'discharged' }> {
  for (const entry of entries) {
    if (entry.kind === 'unreadable') return { kind: 'undecidable' };
    const keyed = entry.intent.epochKey !== undefined;
    const pathMatches =
      entry.intent.epoch === candidate.originalPath ||
      entry.intent.epoch === candidate.epochKey ||
      entry.intent.epoch === dirname(candidate.epoch.path);
    if (keyed ? entry.intent.epochKey !== candidate.epochKey : !pathMatches) continue;
    if (!keyed && ambiguousOriginalPath) return { kind: 'undecidable' };
    if (entry.kind === 'holding') return { kind: 'undecidable' };
    if (entry.kind === 'absent') continue;
    if (entry.binding.process === null) return { kind: 'undecidable' };
    const process = entry.binding.process;
    if (!isProcessIncarnation(process.incarnation)) return { kind: 'undecidable' };
    const observed = observeRecordedContainment(
      { pid: process.pid, incarnation: process.incarnation, processGroupId: process.processGroupId, childRoot: null },
      {
        process: runtime.process,
        platform: runtime.env.platform() as NodeJS.Platform,
        readProcessIncarnation: (pid, platform) => runtime.process.readProcessIncarnation(pid, platform),
      },
    );
    if (observed.kind === 'alive') return { kind: 'alive' };
    if (observed.kind !== 'absent') return { kind: 'undecidable' };
  }
  const shipped = observeShippedDurableCliProcesses(runtime, candidate);
  if (shipped !== 'absent') return { kind: shipped === 'alive' ? 'alive' : 'undecidable' };
  return { kind: 'discharged' };
}

function observeShippedDurableCliProcesses(
  runtime: Runtime,
  candidate: ClosureCandidate,
): 'alive' | 'unknown' | 'absent' {
  let db: ReturnType<Runtime['storage']['openSqliteDatabaseSync']>;
  try {
    db = runtime.storage.openSqliteDatabaseSync(candidate.epoch.path, { readOnly: true });
  } catch {
    return 'unknown';
  }
  try {
    const rows = db
      .prepare(
        "SELECT key, value FROM meta WHERE key LIKE 'durable_cli_process.v%:%' OR key LIKE 'durable_cli_provisional_process.v%:%'",
      )
      .all();
    for (const row of rows) {
      if (typeof row !== 'object' || row === null || !('key' in row) || !('value' in row)) return 'unknown';
      const { key, value } = row;
      if (typeof key !== 'string' || typeof value !== 'string') return 'unknown';
      const version = /^durable_cli_process\.v([12]):(.+)$/u.exec(key);
      const provisional = /^durable_cli_provisional_process\.v1:(.+)$/u.exec(key);
      const full = version?.[1] === '2' ? decodeDurableCliProcessRuntimeMeta(value) : null;
      const predecessor = version?.[1] === '1' ? decodeDurableCliProcessRuntimeMetaV1(value) : null;
      const provisionalRecord = provisional === null ? null : decodeDurableCliProvisionalProcessRuntimeMeta(value);
      const record = full ?? predecessor ?? provisionalRecord;
      if (record === null || record.jobId !== (version?.[2] ?? provisional?.[1])) return 'unknown';
      if ('processGroupId' in record) {
        const contained = observeRecordedContainment(
          {
            pid: record.pid,
            incarnation: record.incarnation,
            processGroupId: record.processGroupId,
            childRoot: full?.childRoot ?? null,
          },
          {
            process: runtime.process,
            platform: runtime.env.platform() as NodeJS.Platform,
            readProcessIncarnation: (pid, platform) => runtime.process.readProcessIncarnation(pid, platform),
          },
        );
        if (contained.kind === 'alive') return 'alive';
        if (contained.kind !== 'absent') return 'unknown';
        continue;
      }
      const observed = runtime.process.observeLiveness(record.pid);
      if (observed === 'unknown') return 'unknown';
      if (observed === 'absent') continue;
      const incarnation = runtime.process.readProcessIncarnation(record.pid, runtime.env.platform() as NodeJS.Platform);
      if (incarnation === null) return 'unknown';
      if (incarnation === record.incarnation) return 'alive';
    }
    return 'absent';
  } catch {
    return 'unknown';
  } finally {
    db.close();
  }
}

/**
 * Confirmed absence remains decisive: an exact incarnation never returns, and an emptied group no longer holds
 * its recorded processes.
 */
type AbsenceProof =
  | Readonly<{ kind: 'reap'; confirmed: Set<string> }>
  | Readonly<{ kind: 'confirmed-only'; confirmed: ReadonlySet<string> }>;

type RecordedProcess = Readonly<{ pid: number; incarnation: ProcessIncarnation; processGroupId: number }>;
type AbsenceDecisionContext = Readonly<{
  runtime: Runtime;
  index: JobLocationIndex;
  jobEpochKey: string;
  signal: AbortSignal;
  closeProxySet: CloseProxySet | undefined;
  absence: AbsenceProof;
}>;

/** Only an owner's decisive absence discharges a bound process; a live or unanswered observation never does. */
type RecordedAbsence = Readonly<{ kind: 'absent' }> | Readonly<{ kind: 'not-proven-absent' }>;
const ABSENT: RecordedAbsence = { kind: 'absent' };
const NOT_PROVEN_ABSENT: RecordedAbsence = { kind: 'not-proven-absent' };

async function decideRecordedAbsence(
  { runtime, index, jobEpochKey, signal, closeProxySet, absence }: AbsenceDecisionContext,
  entry: Extract<CustodyEntry, { kind: 'bound' }>,
  identity: RecordedProcess,
): Promise<RecordedAbsence> {
  const absenceKey = JSON.stringify([entry.intent.id, identity.pid, identity.incarnation, identity.processGroupId]);
  if (entry.intent.owner === 'durable-cli' && absence.kind === 'confirmed-only') {
    return absence.confirmed.has(absenceKey) ? ABSENT : NOT_PROVEN_ABSENT;
  }
  if (entry.intent.owner === 'durable-cli' && absence.kind === 'reap') {
    const clock = createMonotonicClock(closureClockScope, {
      readMilliseconds: () => runtime.time.monotonicNow(),
      sleep: (milliseconds) => runtime.time.sleep(milliseconds),
    });
    try {
      const outcome = await reapRecordedContainment(
        identity,
        [],
        clock.shiftMilliseconds(clock.now(), REAP_DEADLINE_MS),
        {
          maxRecordedRoots: 0,
          clock,
          process: runtime.process,
          platform: runtime.env.platform() as NodeJS.Platform,
          readProcessIncarnation: (pid, platform) => runtime.process.readProcessIncarnation(pid, platform),
          signal,
        },
      );
      if (outcome.kind !== 'containment-absent') return NOT_PROVEN_ABSENT;
      absence.confirmed.add(absenceKey);
      return ABSENT;
    } catch {
      return NOT_PROVEN_ABSENT;
    }
  }
  if (entry.intent.owner === 'provider-proxy-set' && closeProxySet !== undefined) {
    let resultsReady = false;
    try {
      resultsReady = index.resultsReleased(jobEpochKey);
    } catch {
      // Unreadable results keep the owner from requesting proxy containment.
    }
    if (resultsReady) {
      const proxyInstanceId = entry.intent.operationId.endsWith(':guardian')
        ? entry.intent.operationId.slice(0, -':guardian'.length)
        : null;
      if (proxyInstanceId !== null) {
        try {
          await closeProxySet(proxyInstanceId, identity, signal);
        } catch {
          // Failed proxy containment must not settle custody; process observation still decides.
        }
      }
    }
  }
  const observed = observeRecordedContainment(
    { ...identity, childRoot: null },
    {
      process: runtime.process,
      platform: runtime.env.platform() as NodeJS.Platform,
      readProcessIncarnation: (pid, platform) => runtime.process.readProcessIncarnation(pid, platform),
    },
  );
  return observed.kind === 'absent' ? ABSENT : NOT_PROVEN_ABSENT;
}

async function certifyCustody(
  runtime: Runtime,
  index: JobLocationIndex,
  candidate: ClosureCandidate,
  entries: readonly CustodyEntry[],
  ambiguousOriginalPath: boolean,
  signal: AbortSignal,
  closeProxySet: CloseProxySet | undefined,
  jobEpochKey: string,
  absence: AbsenceProof = { kind: 'reap', confirmed: new Set() },
): Promise<Pick<EpochClosureEvidence, 'executionDischarge' | 'obligations' | 'reason'>> {
  if (!hasEpochCustodyCoverage(runtime, dirname(candidate.epoch.path), runtime.paths.coral.coordinator.runDir)) {
    return {
      executionDischarge: 'undecidable',
      obligations: [],
      reason: 'this epoch predates complete pre-effect custody coverage',
    };
  }
  if (!runtime.storage.existsSync(custodyLedgerDir(runtime.paths.coral.coordinator.runDir))) {
    return { executionDischarge: 'undecidable', obligations: [], reason: 'custody ledger root is missing' };
  }
  if (
    ambiguousOriginalPath &&
    entries.some(
      (entry) =>
        entry.kind !== 'unreadable' &&
        entry.intent.epochKey === undefined &&
        entry.intent.epoch === candidate.originalPath,
    )
  ) {
    return {
      executionDischarge: 'undecidable',
      obligations: [],
      reason: 'path-only custody cannot distinguish reused epoch numbers',
    };
  }
  const matching = entries.filter(
    (entry) =>
      entry.kind !== 'unreadable' &&
      (entry.intent.epochKey === undefined
        ? entry.intent.epoch === candidate.originalPath ||
          entry.intent.epoch === dirname(candidate.epoch.path) ||
          entry.intent.epoch === candidate.epochKey
        : entry.intent.epochKey === candidate.epochKey),
  );
  if (entries.some((entry) => entry.kind === 'unreadable')) {
    return {
      executionDischarge: 'undecidable',
      obligations: [],
      reason: 'custody ledger is unreadable; retry after evidence is readable',
    };
  }
  if (matching.length === 0) {
    return {
      executionDischarge: 'certified',
      obligations: [],
      reason: 'covered epoch has no recorded external effects',
    };
  }
  const receipts = readDurableCliControllerReceipts(runtime, runtime.paths.coral.coordinator.runDir);
  const obligations: EpochClosureEvidence['obligations'][number][] = [];
  for (const entry of matching) {
    if (entry.kind === 'unreadable') {
      return { executionDischarge: 'undecidable', obligations, reason: 'custody ledger is unreadable' };
    }
    if (entry.kind === 'holding') {
      return {
        executionDischarge: 'undecidable',
        obligations,
        reason: `custody intent ${entry.intent.id} awaits ${entry.exit}`,
      };
    }
    if (entry.kind === 'absent') {
      obligations.push({
        owner: entry.intent.owner,
        intentId: entry.intent.id,
        outcome: 'absent',
        evidence: entry.evidence,
      });
      continue;
    }
    if (entry.intent.effect === 'provider-operation-publication') {
      let location: ReturnType<JobLocationIndex['read']> = null;
      try {
        if (entry.intent.jobId !== undefined) location = index.read(entry.intent.jobId);
      } catch {
        return {
          executionDischarge: 'undecidable',
          obligations,
          reason: `provider operation ${entry.intent.operationId} result is unreadable`,
        };
      }
      if (location?.epochKey !== jobEpochKey || location.disposition !== 'terminal') {
        return {
          executionDischarge: 'undecidable',
          obligations,
          reason: `provider operation ${entry.intent.operationId} awaits owner terminal result`,
        };
      }
      obligations.push({
        owner: entry.intent.owner,
        intentId: entry.intent.id,
        outcome: 'terminal',
        evidence: `job ${entry.intent.jobId} has a retained terminal location`,
      });
      continue;
    }
    if (entry.binding.process === null) {
      return {
        executionDischarge: 'undecidable',
        obligations,
        reason: `custody intent ${entry.intent.id} has no process identity`,
      };
    }
    if (entry.intent.owner === 'durable-cli') {
      let location: ReturnType<JobLocationIndex['read']>;
      try {
        location = index.read(entry.intent.operationId);
      } catch {
        return {
          executionDischarge: 'undecidable',
          obligations,
          reason: `durable-cli ${entry.intent.operationId} location is unreadable`,
        };
      }
      if (receipts.unreadable.length > 0) {
        return {
          executionDischarge: 'undecidable',
          obligations,
          reason: `controller receipts are unreadable: ${receipts.unreadable.join(', ')}`,
        };
      }
      const transfers = receipts.receipts.filter((receipt) => receipt.jobId === entry.intent.operationId);
      if (
        location?.epochKey !== jobEpochKey ||
        location.disposition !== 'terminal' ||
        (transfers.length > 0 &&
          !transfers.some(
            (receipt) => receipt.custodyIntentId === entry.intent.id && receipt.lineageEpochKey === candidate.epochKey,
          ))
      ) {
        return {
          executionDischarge: 'undecidable',
          obligations,
          reason: `durable-cli ${entry.intent.operationId} awaits terminal result or matching controller receipt`,
        };
      }
    }
    const process = entry.binding.process;
    if (!isProcessIncarnation(process.incarnation)) {
      return {
        executionDischarge: 'undecidable',
        obligations,
        reason: `custody process ${process.pid} has an invalid incarnation`,
      };
    }
    const identity = { pid: process.pid, incarnation: process.incarnation, processGroupId: process.processGroupId };
    const recorded = await decideRecordedAbsence(
      { runtime, index, jobEpochKey, signal, closeProxySet, absence },
      entry,
      identity,
    );
    if (recorded.kind !== 'absent') {
      return {
        executionDischarge: 'undecidable',
        obligations,
        reason: `${entry.intent.owner} ${entry.intent.operationId} awaits owner-controlled process discharge`,
      };
    }
    obligations.push({
      owner: entry.intent.owner,
      intentId: entry.intent.id,
      outcome: entry.intent.owner === 'durable-cli' ? 'terminal-and-absent' : 'absent',
      evidence: `recorded process ${process.pid}/${process.incarnation} and group ${process.processGroupId} absent`,
    });
  }
  return { executionDischarge: 'certified', obligations, reason: 'owners certified every recorded custody obligation' };
}

async function certifyRetiringEpochCustody(
  runtime: Runtime,
  index: JobLocationIndex,
  epochKey: string,
  signal: AbortSignal,
  absence: AbsenceProof,
): Promise<boolean> {
  const lineageKey = decodeResolvedStoreEpoch(runtime, epochKey)?.lineageKey;
  const candidate = closureCandidates(runtime).find((entry) => entry.epochKey === lineageKey);
  if (candidate === undefined) return false;
  const entries = readCustodyLedger(runtime, runtime.paths.coral.coordinator.runDir);
  const settlement = await certifyCustody(
    runtime,
    index,
    candidate,
    entries,
    false,
    signal,
    undefined,
    epochKey,
    absence,
  );
  return settlement.executionDischarge === 'certified';
}

/** Only `certify` may discharge custody; `confirm` must neither wait on a process nor discharge a new obligation. */
export class RetiringCustodyCertificate {
  readonly #epochKey: string;
  readonly #confirmedAbsent: ReadonlySet<string>;

  private constructor(epochKey: string, confirmedAbsent: ReadonlySet<string>) {
    this.#epochKey = epochKey;
    this.#confirmedAbsent = confirmedAbsent;
  }

  static async certify(
    runtime: Runtime,
    index: JobLocationIndex,
    epochKey: string,
    signal: AbortSignal,
  ): Promise<RetiringCustodyCertificate | null> {
    const confirmed = new Set<string>();
    const certified = await certifyRetiringEpochCustody(runtime, index, epochKey, signal, { kind: 'reap', confirmed });
    return certified ? new RetiringCustodyCertificate(epochKey, confirmed) : null;
  }

  confirm(runtime: Runtime, index: JobLocationIndex, signal: AbortSignal): Promise<boolean> {
    return certifyRetiringEpochCustody(runtime, index, this.#epochKey, signal, {
      kind: 'confirmed-only',
      confirmed: this.#confirmedAbsent,
    });
  }
}

export async function settleSupersededEpochClosures(
  runtime: Runtime,
  index: JobLocationIndex,
  signal?: AbortSignal,
  subjectKey?: string,
  activeEpochKey?: string,
  closeProxySet?: CloseProxySet,
): Promise<EpochClosureEvidence[]> {
  const stateRoot = runtime.paths.coral.generation.dataRoot;
  const candidates = closureCandidates(runtime);
  if (candidates.length === 0) return [];
  const uncertifiable = uncertifiableEpochKeys(runtime, activeEpochKey);
  if (uncertifiable === null) return [];
  const isUncertifiable = (epochKey: string): boolean => {
    if (uncertifiable.has(epochKey)) return true;
    const current = uncertifiableEpochKeys(runtime, activeEpochKey);
    return current === null || current.has(epochKey);
  };
  const custody = readCustodyLedger(runtime, runtime.paths.coral.coordinator.runDir);
  const evidence: EpochClosureEvidence[] = [];
  const keepRecorded = (recording: EpochClosureRecording): void => {
    if (recording.kind === 'recorded') evidence.push(recording.evidence);
  };
  let historicalAddresses: ReturnType<typeof knownProtectedEpochAddresses>;
  try {
    historicalAddresses = knownProtectedEpochAddresses(
      runtime,
      runtime.storage.realpathSync(runtime.paths.coral.store.dbDir),
    );
  } catch {
    for (const candidate of candidates) {
      if (isUncertifiable(candidate.epochKey)) continue;
      keepRecorded(
        recordEpochClosure(runtime, stateRoot, {
          version: 'v1',
          epochKey: candidate.epochKey,
          disposition: 'unrecoverable-retained',
          dataOutcome: 'unreadable',
          executionDischarge: 'undecidable',
          obligations: [],
          reason: 'protected address map is unreadable',
          observedAtMs: runtime.time.now(),
        }),
      );
    }
    return evidence;
  }
  for (const candidate of candidates) {
    if (signal?.aborted) break;
    if (subjectKey !== undefined && subjectKey !== candidate.epochKey) continue;
    if (isUncertifiable(candidate.epochKey)) continue;
    const jobEpochKey = lineageJobEpochKey(
      candidate.epoch.canonicalStoreRoot ?? candidate.epoch.storeRoot,
      candidate.epochKey,
    );
    const read = observeEpochClosure(runtime, stateRoot, candidate.epochKey);
    if (read.kind === 'unsupported') continue;
    if (read.kind === 'unreadable' && !setAsideUnreadableEpochClosure(runtime, stateRoot, candidate.epochKey)) continue;
    const previous = read.kind === 'recorded' ? read.evidence : null;
    let dataOutcome: EpochClosureEvidence['dataOutcome'];
    try {
      dataOutcome = index.resultsReleased(jobEpochKey)
        ? 'retained'
        : index.unknownLocationHold(jobEpochKey) !== null
          ? 'unreadable'
          : 'unknown';
    } catch {
      dataOutcome = 'unreadable';
    }
    if (previous?.disposition === 'closed') {
      keepRecorded(
        previous.dataOutcome === dataOutcome
          ? { kind: 'recorded', evidence: previous }
          : recordEpochClosure(runtime, stateRoot, {
              ...previous,
              dataOutcome,
              observedAtMs: runtime.time.now(),
            }),
      );
      continue;
    }
    const ambiguousOriginalPath =
      candidates.some(
        (other) => other.epochKey !== candidate.epochKey && other.originalPath === candidate.originalPath,
      ) ||
      historicalAddresses.some(
        (address) => address.epochKey !== candidate.epochKey && address.originalPath === candidate.originalPath,
      );
    const preCoverage = predatesCustodyCoverage(runtime, candidate);
    const liveCustody = preCoverage
      ? observePreCoverageCustody(runtime, candidate, custody, ambiguousOriginalPath)
      : null;
    const settlement = preCoverage
      ? liveCustody?.kind === 'alive'
        ? {
            executionDischarge: 'undecidable' as const,
            obligations: [],
            reason: 'pre-coverage process is alive; retry after its recorded incarnation exits',
          }
        : liveCustody?.kind === 'undecidable'
          ? {
              executionDischarge: 'undecidable' as const,
              obligations: [],
              reason: 'pre-coverage custody is undecidable; retry after custody evidence settles',
            }
          : {
              executionDischarge: 'certified' as const,
              obligations: [],
              reason: 'pre-coverage epoch follows shipped keep-two retention',
            }
      : await certifyCustody(
          runtime,
          index,
          candidate,
          custody,
          ambiguousOriginalPath,
          signal ?? new AbortController().signal,
          closeProxySet,
          jobEpochKey,
        );
    if (isUncertifiable(candidate.epochKey)) continue;
    keepRecorded(
      recordEpochClosure(runtime, stateRoot, {
        version: 'v1',
        epochKey: candidate.epochKey,
        disposition: settlement.executionDischarge === 'certified' ? 'closed' : 'unrecoverable-retained',
        dataOutcome,
        ...settlement,
        observedAtMs: runtime.time.now(),
      }),
    );
  }
  return evidence;
}
