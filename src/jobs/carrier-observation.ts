import type { JobPhase } from './phase.js';

/**
 * Whether the thing actually carrying a stored-nonterminal job is still there.
 *
 * Tri-state on purpose. `absent` is a positive finding — evidence that the exact carrier this job named is
 * gone — and it is the only value that may ever be rendered as an interruption. `unknown` means the question
 * was not answered, which is not the same as answering "no": treating it as absence would let a slow socket,
 * a foreign build, or a failed capture retire work that is still running. Every consumer therefore treats
 * `unknown` as conservatively active.
 */
export type CarrierLiveness = 'live' | 'absent' | 'unknown';

/**
 * Which authority answered. Kept beside the verdict because the same `unknown` means different things
 * — "no local registry entry" is a coordinator-local fact, "the probe did not complete" is a transport fact —
 * and a consumer that logs or alerts needs to tell them apart without re-deriving the classification.
 */
export type CarrierObservationSource =
  | 'local-admission'
  | 'local-operation-registry'
  | 'local-workflow-owner'
  | 'local-internal-registry'
  | 'durable-cli-process'
  | 'proxy-operation-status'
  | 'no-local-evidence';

/**
 * The carrier classes of the plan's authority table, each named for the thing that actually holds the work.
 * They are distinct because their evidence is distinct, not because their jobs differ: an app-server job
 * that has not yet acquired an operation cannot be checked against an operation tuple, so assuming one would
 * manufacture absence out of a job that is merely early.
 */
export type CarrierClass =
  | 'queued-or-launching'
  | 'app-server-waiting'
  | 'app-server-acquired'
  | 'workflow'
  | 'internal-hosted-kb'
  | 'durable-cli';

/**
 * What the local coordinator knows about one app-server operation.
 *
 * `inherited` is the case this distinction exists for: this coordinator never activated or attached the
 * operation, but the durable provider-operation record may name a predecessor build whose proxy is still
 * running. Runtime metadata contains only `HostRef`, never the operation tuple. Locally this state is
 * `unknown`, never `absent`, because the only thing proven is that *this* process has no registry entry.
 */
export type LocalOperationRegistryState = 'activated' | 'attached' | 'inherited';

/**
 * Whether startup recovery can account for a job without mistaking durable saga ownership for a skipped
 * local attachment. The middle state is essential: a provider-operation record may still own recovery even
 * though this coordinator has no live registry entry for it.
 */
export type JobRecoveryCoverage = 'in-progress' | 'accounted-for' | 'unaccounted';

/**
 * The durable CLI's recorded process identity, or why it is missing.
 *
 * A pid alone is not identity — the OS recycles it — so `matchesRecordedStart` is what separates "the
 * process we launched is still running" from "some unrelated process now holds that number". A launch that
 * could not capture or write its meta yields `uncaptured`, which is `unknown` rather than `absent`: nothing
 * was learned about the child, only about the record.
 */
export type DurableCliProcessEvidence =
  | Readonly<{ kind: 'recorded'; alive: boolean; matchesRecordedStart: boolean; transportEvidence: boolean }>
  | Readonly<{ kind: 'uncaptured' }>;

/** The evidence one stored-nonterminal job's class is judged by. */
export type CarrierEvidence =
  | Readonly<{ carrierClass: 'queued-or-launching'; admittedByThisCoordinator: boolean }>
  | Readonly<{ carrierClass: 'app-server-waiting'; admittedByThisCoordinator: boolean }>
  | Readonly<{
      carrierClass: 'app-server-acquired';
      registryState: LocalOperationRegistryState;
      proxyOperationStatus?: 'held' | 'absent' | 'unknown';
    }>
  | Readonly<{ carrierClass: 'workflow'; ownedByThisCoordinator: boolean }>
  | Readonly<{ carrierClass: 'internal-hosted-kb'; memberOfSupervisor: boolean }>
  | Readonly<{ carrierClass: 'durable-cli'; process: DurableCliProcessEvidence }>;

/**
 * The one condition under which a locally derived `unknown` is a defect rather than an honest answer.
 *
 * Startup recovery is what bounds local unknowns, but its durable provider-operation journal can keep
 * owning a job after the barrier passes and before a local registry entry exists. Only a job with neither
 * local evidence nor that durable owner is unaccounted; reporting it beats throwing on a read path because
 * the verdict stays conservatively active either way.
 */
export type CarrierObservationDefect = 'local-unknown-after-recovery-decision';

export type CarrierObservation = Readonly<{
  /** Carried through untouched. Observation never rewrites, filters, or reorders stored lifecycle. */
  storedPhase: JobPhase;
  carrierClass: CarrierClass;
  liveness: CarrierLiveness;
  source: CarrierObservationSource;
  /** The journal position this verdict was formed against, so a later terminal can be seen to win. */
  observedMaxJournalSeq: number;
  defect?: CarrierObservationDefect;
}>;

/**
 * The complete, already-gathered input keeps classification pure while making durable recovery ownership an
 * explicit per-job fact rather than process-wide timing guessed inside the classifier.
 */
export type CarrierObservationInput = Readonly<{
  storedPhase: JobPhase;
  evidence: CarrierEvidence;
  observedMaxJournalSeq: number;
  recoveryCoverage: JobRecoveryCoverage;
}>;

type Verdict = Readonly<{ liveness: CarrierLiveness; source: CarrierObservationSource }>;

/**
 * A registry entry this coordinator made is the strongest local evidence there is; its absence is the
 * weakest. There is no state in between: the registry deletes an entry the instant its operation settles
 * (`LocalOperationRegistry.settled`) rather than marking it ended, so an operation this coordinator watched
 * all the way through is locally indistinguishable from one it never had — both read as `inherited`.
 */
function acquiredVerdict(evidence: Extract<CarrierEvidence, { carrierClass: 'app-server-acquired' }>): Verdict {
  switch (evidence.registryState) {
    case 'activated':
    case 'attached':
      return { liveness: 'live', source: 'local-operation-registry' };
    case 'inherited':
      switch (evidence.proxyOperationStatus) {
        case 'held':
          return { liveness: 'live', source: 'proxy-operation-status' };
        case 'absent':
          return { liveness: 'absent', source: 'proxy-operation-status' };
        case 'unknown':
          return { liveness: 'unknown', source: 'proxy-operation-status' };
        case undefined:
          return { liveness: 'unknown', source: 'no-local-evidence' };
      }
  }
}

/**
 * Two of the three recorded facts actually vary: pid liveness alone is not enough, since a recycled pid is
 * alive and is not this job, so `matchesRecordedStart` is what tells a resurrected identity from the genuine
 * one. `transportEvidence` stays fixed `true` at every production evidence builder — a durable CLI has no
 * control channel to source a contradicting signal from (`runtime-meta.ts`'s own doc on why the recorded
 * identity is pid-plus-start-time and nothing more) — so today only the first two can turn this `absent`.
 */
function durableCliVerdict(process: DurableCliProcessEvidence): Verdict {
  if (process.kind === 'uncaptured') return { liveness: 'unknown', source: 'no-local-evidence' };
  const live = process.alive && process.matchesRecordedStart && process.transportEvidence;
  return { liveness: live ? 'live' : 'absent', source: 'durable-cli-process' };
}

function verdictFor(evidence: CarrierEvidence): Verdict {
  switch (evidence.carrierClass) {
    case 'queued-or-launching':
    case 'app-server-waiting':
      // Admission is the whole claim for both: one has no process yet and the other has no operation yet,
      // so the only thing either can be checked against is whether this coordinator admitted it.
      return evidence.admittedByThisCoordinator
        ? { liveness: 'live', source: 'local-admission' }
        : { liveness: 'unknown', source: 'no-local-evidence' };
    case 'app-server-acquired':
      return acquiredVerdict(evidence);
    case 'workflow':
      return evidence.ownedByThisCoordinator
        ? { liveness: 'live', source: 'local-workflow-owner' }
        : { liveness: 'unknown', source: 'no-local-evidence' };
    case 'internal-hosted-kb':
      // Supervisor membership, never daemon-online state: a running KB daemon says nothing about whether
      // this particular job is still one of the things it is running.
      return evidence.memberOfSupervisor
        ? { liveness: 'live', source: 'local-internal-registry' }
        : { liveness: 'unknown', source: 'no-local-evidence' };
    case 'durable-cli':
      return durableCliVerdict(evidence.process);
  }
}

/**
 * Classifies one stored-nonterminal job's carrier from already-gathered evidence.
 *
 * Pure by construction — no clock, no filesystem, no socket. Health and idle pass local evidence only;
 * wait may pass the external status already returned by the read-only proxy observer.
 */
export function classifyCarrier(input: CarrierObservationInput): CarrierObservation {
  const { liveness, source } = verdictFor(input.evidence);
  const observation: CarrierObservation = {
    storedPhase: input.storedPhase,
    carrierClass: input.evidence.carrierClass,
    liveness,
    source,
    observedMaxJournalSeq: input.observedMaxJournalSeq,
  };
  if (
    input.recoveryCoverage === 'unaccounted' &&
    liveness === 'unknown' &&
    input.evidence.carrierClass === 'app-server-acquired'
  ) {
    return { ...observation, defect: 'local-unknown-after-recovery-decision' };
  }
  return observation;
}
