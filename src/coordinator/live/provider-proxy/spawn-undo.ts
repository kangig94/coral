import { errorMessage } from '../../../infra/error-format.js';
import {
  createRecordedProcessObserver,
  incarnationMayAuthorizeSignal,
  processIncarnationSchema,
  type ProcessIncarnation,
} from '../../../infra/node-process.js';
import { createMonotonicClock } from '../../../infra/monotonic-clock.js';
import {
  ProcessContainmentError,
  reapRecordedContainment,
  type RecordedContainmentIdentity,
} from '../../../infra/process-containment.js';
import {
  liveChildAuthority,
  observeUnattributableSpawnedProcessGroup,
  type SpawnedProcessGroupAbsenceEvidence,
} from '../../../infra/process-supervision.js';
import type { ControlClient, ControlExchange } from '../../../provider-proxy/control-client.js';
import { PROXY_TEARDOWN_RESERVE_MS } from '../../../provider-proxy/orphan-deadline.js';
import {
  guardianContainmentCommitParamsSchema,
  guardianContainmentCommitResultSchema,
  GUARDIAN_CONSTRUCTION_CONTAINMENT_SETTLED_EXIT_CODE,
  providerProxyDisappearanceReceipt,
  type GuardianIdentity,
  type ProxyIdentity,
  type ReaperIdentity,
} from '../../../provider-proxy/protocol.js';
import type { SpawnedRoleProcess } from '../../../provider-proxy/role-spawn.js';
import type { Runtime } from '../../../runtime/ports.js';

type GuardianControlTeardown = Readonly<{
  client: ControlClient;
  guardian: GuardianIdentity;
  reaper: ReaperIdentity;
  proxy: ProxyIdentity;
}>;

export type GuardianSpawnUndoRecoverySubject = Readonly<{
  guardianIdentity: RecordedContainmentIdentity;
  reaper:
    | Readonly<{ kind: 'not-created' }>
    | Readonly<{ kind: 'recorded'; pid: number; incarnation: ProcessIncarnation }>
    | Readonly<{ kind: 'possible-unidentified' }>;
  constructionContainmentSettled: boolean;
  proxy:
    | Readonly<{ kind: 'not-created' }>
    | Readonly<{ kind: 'recorded'; identity: RecordedContainmentIdentity }>
    | Readonly<{ kind: 'possible-unidentified' }>;
}>;

export type PreIdentityRoleSpawnRecoverySubject =
  | Readonly<{ kind: 'spawned-process-group'; processGroupId: number }>
  | Readonly<{ kind: 'unattributable-process-group' }>;

export type ProviderProxyAcquisitionRecoverySubject =
  | GuardianSpawnUndoRecoverySubject
  | PreIdentityRoleSpawnRecoverySubject;

export type GuardianSpawnUndoRecoverySubjectInput = Readonly<{
  guardianIdentity: Readonly<{ pid: number; incarnation: string; processGroupId: number }>;
  reaper:
    | Readonly<{ kind: 'not-created' }>
    | Readonly<{ kind: 'recorded'; pid: number; incarnation: string }>
    | Readonly<{ kind: 'possible-unidentified' }>;
  constructionContainmentSettled: boolean;
  proxy:
    | Readonly<{ kind: 'not-created' }>
    | Readonly<{
        kind: 'recorded';
        identity: Readonly<{ pid: number; incarnation: string; processGroupId: number }>;
      }>
    | Readonly<{ kind: 'possible-unidentified' }>;
}>;

export type ProviderProxyAcquisitionRecoverySubjectInput =
  | GuardianSpawnUndoRecoverySubjectInput
  | PreIdentityRoleSpawnRecoverySubject;

function validateRecordedContainmentIdentity(
  identity: GuardianSpawnUndoRecoverySubjectInput['guardianIdentity'],
): RecordedContainmentIdentity {
  return { ...identity, incarnation: processIncarnationSchema.parse(identity.incarnation) };
}

export function validateGuardianSpawnUndoRecoverySubject(
  subject: GuardianSpawnUndoRecoverySubjectInput,
): GuardianSpawnUndoRecoverySubject {
  return {
    guardianIdentity: validateRecordedContainmentIdentity(subject.guardianIdentity),
    reaper:
      subject.reaper.kind === 'recorded'
        ? { ...subject.reaper, incarnation: processIncarnationSchema.parse(subject.reaper.incarnation) }
        : subject.reaper,
    constructionContainmentSettled: subject.constructionContainmentSettled,
    proxy:
      subject.proxy.kind === 'recorded'
        ? { kind: 'recorded', identity: validateRecordedContainmentIdentity(subject.proxy.identity) }
        : subject.proxy,
  };
}

function sameRecordedContainmentIdentity(
  left: RecordedContainmentIdentity,
  right: RecordedContainmentIdentity,
): boolean {
  return (
    left.pid === right.pid && left.incarnation === right.incarnation && left.processGroupId === right.processGroupId
  );
}

function sameRecoverySubject(left: GuardianSpawnUndoRecoverySubject, right: GuardianSpawnUndoRecoverySubject): boolean {
  if (
    !sameRecordedContainmentIdentity(left.guardianIdentity, right.guardianIdentity) ||
    left.constructionContainmentSettled !== right.constructionContainmentSettled ||
    left.reaper.kind !== right.reaper.kind ||
    left.proxy.kind !== right.proxy.kind
  ) {
    return false;
  }
  if (
    left.reaper.kind === 'recorded' &&
    right.reaper.kind === 'recorded' &&
    (left.reaper.pid !== right.reaper.pid || left.reaper.incarnation !== right.reaper.incarnation)
  ) {
    return false;
  }
  return (
    left.proxy.kind !== 'recorded' ||
    (right.proxy.kind === 'recorded' && sameRecordedContainmentIdentity(left.proxy.identity, right.proxy.identity))
  );
}

function isPreIdentityRoleSpawnRecoverySubject(
  subject: ProviderProxyAcquisitionRecoverySubjectInput,
): subject is PreIdentityRoleSpawnRecoverySubject {
  return 'kind' in subject;
}

function sameAcquisitionRecoverySubject(
  left: ProviderProxyAcquisitionRecoverySubject,
  right: ProviderProxyAcquisitionRecoverySubjectInput,
): boolean {
  if (isPreIdentityRoleSpawnRecoverySubject(left) || isPreIdentityRoleSpawnRecoverySubject(right)) {
    return (
      isPreIdentityRoleSpawnRecoverySubject(left) &&
      isPreIdentityRoleSpawnRecoverySubject(right) &&
      left.kind === right.kind &&
      (left.kind !== 'spawned-process-group' ||
        (right.kind === 'spawned-process-group' && left.processGroupId === right.processGroupId))
    );
  }
  return sameRecoverySubject(left, validateGuardianSpawnUndoRecoverySubject(right));
}

const providerProxyAcquisitionAbsenceEvidenceBrand: unique symbol = Symbol(
  'coral.provider-proxy.acquisition-absence-evidence',
);

export type ProviderProxyAcquisitionAbsenceEvidence = Readonly<{
  recoverySubject: ProviderProxyAcquisitionRecoverySubject;
  disappearanceReceipt: string;
  [providerProxyAcquisitionAbsenceEvidenceBrand]: true;
}>;

export type GuardianSpawnUndoRecoveryProof = Readonly<{
  subject: GuardianSpawnUndoRecoverySubject;
  absenceEvidence(): ProviderProxyAcquisitionAbsenceEvidence;
}>;

function recordedRecoveryRoots(subject: GuardianSpawnUndoRecoverySubject): readonly Readonly<{
  pid: number;
  incarnation: ProcessIncarnation;
}>[] {
  return [
    ...(subject.proxy.kind === 'recorded'
      ? [{ pid: subject.proxy.identity.pid, incarnation: subject.proxy.identity.incarnation }]
      : []),
    ...(subject.reaper.kind === 'recorded'
      ? [{ pid: subject.reaper.pid, incarnation: subject.reaper.incarnation }]
      : []),
  ];
}

function acquisitionAbsenceEvidence(
  subject: GuardianSpawnUndoRecoverySubject,
): ProviderProxyAcquisitionAbsenceEvidence {
  return Object.freeze({
    recoverySubject: subject,
    disappearanceReceipt: providerProxyDisappearanceReceipt(subject.guardianIdentity, recordedRecoveryRoots(subject)),
    [providerProxyAcquisitionAbsenceEvidenceBrand]: true as const,
  });
}

export function isProviderProxyAcquisitionAbsenceEvidenceFor(
  evidence: ProviderProxyAcquisitionAbsenceEvidence,
  subject: ProviderProxyAcquisitionRecoverySubjectInput,
): boolean {
  if (evidence[providerProxyAcquisitionAbsenceEvidenceBrand] !== true) return false;
  try {
    return sameAcquisitionRecoverySubject(evidence.recoverySubject, subject);
  } catch {
    return false;
  }
}

export function preIdentityRoleSpawnAbsenceEvidence(
  groupEvidence: SpawnedProcessGroupAbsenceEvidence,
): ProviderProxyAcquisitionAbsenceEvidence {
  const subject: Extract<PreIdentityRoleSpawnRecoverySubject, { kind: 'spawned-process-group' }> = {
    kind: 'spawned-process-group',
    processGroupId: groupEvidence.subject.processGroupId,
  };
  return Object.freeze({
    recoverySubject: subject,
    disappearanceReceipt: `spawned-process-group:${subject.processGroupId}:absent`,
    [providerProxyAcquisitionAbsenceEvidenceBrand]: true as const,
  });
}

const guardianSpawnUndoClockScope: unique symbol = Symbol('coral.provider-proxy.guardian-spawn-undo');
const durableGuardianReobservationClockScope: unique symbol = Symbol(
  'coral.provider-proxy.durable-guardian-reobservation',
);

export async function reobserveDurableProviderProxyAcquisitionContainment(
  runtime: Runtime,
  subjectInput: ProviderProxyAcquisitionRecoverySubjectInput,
  signal: AbortSignal,
): Promise<
  | Readonly<{ kind: 'containment-absent'; evidence: ProviderProxyAcquisitionAbsenceEvidence }>
  | Readonly<{ kind: 'held'; observation: 'alive' | 'unknown'; reason: string }>
> {
  if (isPreIdentityRoleSpawnRecoverySubject(subjectInput)) {
    if (subjectInput.kind === 'unattributable-process-group') {
      return {
        kind: 'held',
        observation: 'unknown',
        reason: 'spawned process-group attribution remains unavailable',
      };
    }
    const observation = observeUnattributableSpawnedProcessGroup(subjectInput.processGroupId, runtime);
    return observation.kind === 'observed-absent'
      ? { kind: 'containment-absent', evidence: preIdentityRoleSpawnAbsenceEvidence(observation.evidence) }
      : {
          kind: 'held',
          observation: 'unknown',
          reason: `spawned_process_group_${observation.observation}`,
        };
  }
  const subject = validateGuardianSpawnUndoRecoverySubject(subjectInput);
  const { guardianIdentity } = subject;
  const observeRecordedReaper = () => {
    if (subject.reaper.kind === 'possible-unidentified') {
      return subject.constructionContainmentSettled
        ? null
        : ({
            kind: 'held' as const,
            observation: 'unknown' as const,
            reason: 'reaper identity remains unavailable without decisive construction containment evidence',
          } as const);
    }
    if (subject.reaper.kind !== 'recorded') return null;
    const observeReaper = createRecordedProcessObserver({
      readIncarnation: (pid) => runtime.process.readProcessIncarnation(pid, runtime.env.platform() as NodeJS.Platform),
      observeLiveness: (pid) => runtime.process.observeLiveness(pid),
    });
    const observation = observeReaper(subject.reaper);
    return observation === 'absent'
      ? null
      : ({ kind: 'held' as const, observation, reason: `reaper_${observation}` } as const);
  };
  if (subject.proxy.kind === 'possible-unidentified') {
    if (subject.constructionContainmentSettled) {
      const reaperHold = observeRecordedReaper();
      if (reaperHold !== null) return reaperHold;
      return {
        kind: 'containment-absent',
        evidence: acquisitionAbsenceEvidence(subject),
      };
    }
    const observedIncarnation = runtime.process.readProcessIncarnation(
      guardianIdentity.pid,
      runtime.env.platform() as NodeJS.Platform,
    );
    return {
      kind: 'held',
      observation: observedIncarnation === guardianIdentity.incarnation ? 'alive' : 'unknown',
      reason: 'proxy identity remains unavailable, so guardian absence cannot finalize acquisition containment',
    };
  }
  const clock = createMonotonicClock(durableGuardianReobservationClockScope, {
    readMilliseconds: () => runtime.time.monotonicNow(),
    sleep: (milliseconds) => runtime.time.sleep(milliseconds, { signal }),
  });
  try {
    if (subject.proxy.kind === 'recorded') {
      const proxyOutcome = await reapRecordedContainment(
        subject.proxy.identity,
        [],
        clock.shiftMilliseconds(clock.now(), PROXY_TEARDOWN_RESERVE_MS),
        {
          maxRecordedRoots: 0,
          clock,
          process: runtime.process,
          platform: runtime.env.platform() as NodeJS.Platform,
          readProcessIncarnation: (pid, platform) => runtime.process.readProcessIncarnation(pid, platform),
          signal,
        },
      );
      if (proxyOutcome.kind !== 'containment-absent') {
        return { kind: 'held', observation: 'unknown', reason: `proxy_${proxyOutcome.kind}` };
      }
    }
    const guardianGroupOutcome = await reapRecordedContainment(
      guardianIdentity,
      [],
      clock.shiftMilliseconds(clock.now(), PROXY_TEARDOWN_RESERVE_MS),
      {
        maxRecordedRoots: 0,
        clock,
        process: runtime.process,
        platform: runtime.env.platform() as NodeJS.Platform,
        readProcessIncarnation: (pid, platform) => runtime.process.readProcessIncarnation(pid, platform),
        signal,
      },
    );
    if (guardianGroupOutcome.kind === 'containment-absent') {
      return {
        kind: 'containment-absent',
        evidence: acquisitionAbsenceEvidence(subject),
      };
    }
    return { kind: 'held', observation: 'unknown', reason: `guardian_${guardianGroupOutcome.kind}` };
  } catch (error: unknown) {
    return { kind: 'held', observation: 'unknown', reason: errorMessage(error) };
  }
}

export type GuardianSpawnUndo = (() => Promise<void>) &
  Readonly<{
    guardianIdentity: RecordedContainmentIdentity;
    recoverySubject(): GuardianSpawnUndoRecoverySubject;
    captureRecoveryProof(): GuardianSpawnUndoRecoveryProof;
    retainPossibleProxy(): void;
    bindProxyIdentity(identity: RecordedContainmentIdentity): void;
    bindControl(control: GuardianControlTeardown): void;
  }>;

function requireAcknowledgedAbsence(exchange: ControlExchange): void {
  if (exchange.kind !== 'response') {
    throw new Error(`guardian acquisition teardown could not be confirmed: ${errorMessage(exchange.error)}`);
  }
  if (exchange.response.kind === 'refusal') {
    throw new Error(`guardian acquisition teardown was refused: ${exchange.response.error.message}`);
  }
  const parsed = guardianContainmentCommitResultSchema.safeParse(exchange.response.value);
  if (!parsed.success) {
    throw new Error(`guardian acquisition teardown replied with an undecodable result: ${parsed.error.message}`);
  }
  if (parsed.data.state === 'teardown-latched-absence-unconfirmed') {
    throw new Error(`guardian acquisition teardown was refused: ${parsed.data.reason}`);
  }
}

/** A control-plane refusal must strand the guardian without falling back to process signals. */
export function buildGuardianSpawnUndo(
  runtime: Runtime,
  spawned: SpawnedRoleProcess,
  platform: NodeJS.Platform,
  readProcessIncarnation: (pid: number, platform: NodeJS.Platform) => ProcessIncarnation | null,
): GuardianSpawnUndo {
  let control: GuardianControlTeardown | null = null;
  let proxyIdentity: RecordedContainmentIdentity | null = null;
  let proxyMayExist = false;
  let constructionContainmentSettled = false;
  let absenceConfirmed = false;
  let pending: Promise<void> | null = null;
  const guardianIdentity: RecordedContainmentIdentity = {
    pid: spawned.pid,
    incarnation: spawned.incarnation,
    processGroupId: spawned.pid,
  };
  const guardianAuthority = liveChildAuthority(spawned.child);

  const perform = async (): Promise<void> => {
    if (absenceConfirmed) return;
    if (control !== null) {
      const established = control;
      const exchange = await established.client.exchange(
        'guardian.containment-commit.v1',
        guardianContainmentCommitParamsSchema.parse({
          guardian: established.guardian,
          reaper: established.reaper,
          proxy: established.proxy,
        }),
        PROXY_TEARDOWN_RESERVE_MS,
      );
      requireAcknowledgedAbsence(exchange);
      absenceConfirmed = true;
      established.client.close();
      return;
    }

    if (proxyMayExist && proxyIdentity === null) {
      if (constructionContainmentSettled) {
        absenceConfirmed = true;
        return;
      }
      throw new Error(
        'guardian process-group cleanup is holding until the guardian reports construction containment settled or the proxy identity transfers to the coordinator',
      );
    }
    const retainedProxyIdentity = proxyIdentity;

    const clock = createMonotonicClock(guardianSpawnUndoClockScope, {
      readMilliseconds: () => runtime.time.monotonicNow(),
      sleep: (milliseconds) => runtime.time.sleep(milliseconds),
    });
    try {
      if (retainedProxyIdentity !== null) {
        if (!incarnationMayAuthorizeSignal(platform)) {
          throw new Error(
            'proxy process-group cleanup is holding because this platform cannot bind a signal to its recorded incarnation',
          );
        }
        const proxyResult = await reapRecordedContainment(
          retainedProxyIdentity,
          [],
          clock.shiftMilliseconds(clock.now(), PROXY_TEARDOWN_RESERVE_MS),
          {
            maxRecordedRoots: 0,
            clock,
            process: runtime.process,
            platform,
            readProcessIncarnation,
          },
        );
        if (proxyResult.kind === 'recorded-group-unattributable') {
          throw new Error('proxy process-group cleanup is holding because the recorded group became unattributable');
        }
        if (proxyResult.kind === 'signal-authorization-refused') {
          throw new Error('proxy process-group cleanup is holding because signal authorization was refused');
        }
        if (proxyResult.kind === 'identity-unobservable') {
          throw new Error(
            proxyResult.signalDelivered
              ? 'proxy process-group cleanup is holding because identity became unobservable after a signal was delivered'
              : 'proxy process-group cleanup is holding because identity observation did not authorize a signal',
          );
        }
      }
      const guardianGroupResult = await reapRecordedContainment(
        guardianIdentity,
        [],
        clock.shiftMilliseconds(clock.now(), PROXY_TEARDOWN_RESERVE_MS),
        {
          maxRecordedRoots: 0,
          clock,
          process: runtime.process,
          platform,
          readProcessIncarnation,
          knownLiveChildFor: (pid) => (pid === guardianIdentity.pid ? guardianAuthority : undefined),
        },
      );
      if (guardianGroupResult.kind === 'recorded-group-unattributable') {
        throw new Error('guardian process-group cleanup is holding because the recorded group became unattributable');
      }
      if (guardianGroupResult.kind === 'signal-authorization-refused') {
        throw new Error('guardian process-group cleanup is holding because signal authorization was refused');
      }
      if (guardianGroupResult.kind === 'identity-unobservable') {
        throw new Error(
          guardianGroupResult.signalDelivered
            ? 'guardian process-group cleanup is holding because identity became unobservable after a signal was delivered'
            : 'guardian process-group cleanup is holding because identity observation did not authorize a signal',
        );
      }
      absenceConfirmed = true;
    } catch (error: unknown) {
      if (error instanceof ProcessContainmentError) {
        throw new Error('guardian process-group cleanup is holding because absence could not be confirmed', {
          cause: error,
        });
      }
      throw error;
    }
  };
  const run = (): Promise<void> => {
    if (absenceConfirmed) return Promise.resolve();
    if (pending !== null) return pending;
    pending = perform().finally(() => {
      pending = null;
    });
    return pending;
  };
  const recoverySubject = (): GuardianSpawnUndoRecoverySubject => ({
    guardianIdentity,
    reaper:
      control === null
        ? { kind: 'possible-unidentified' }
        : { kind: 'recorded', pid: control.reaper.pid, incarnation: control.reaper.incarnation },
    constructionContainmentSettled,
    proxy:
      proxyIdentity !== null
        ? { kind: 'recorded', identity: proxyIdentity }
        : proxyMayExist
          ? { kind: 'possible-unidentified' }
          : { kind: 'not-created' },
  });
  return Object.assign(run, {
    guardianIdentity,
    recoverySubject,
    captureRecoveryProof: (): GuardianSpawnUndoRecoveryProof => {
      const subject = recoverySubject();
      return {
        subject,
        absenceEvidence: (): ProviderProxyAcquisitionAbsenceEvidence => {
          if (!absenceConfirmed) throw new Error('provider_proxy_acquisition_absence_not_confirmed');
          return acquisitionAbsenceEvidence(subject);
        },
      };
    },
    retainPossibleProxy: (): void => {
      if (proxyMayExist) return;
      proxyMayExist = true;
      spawned.child.on('close', (code, signal) => {
        if (code === GUARDIAN_CONSTRUCTION_CONTAINMENT_SETTLED_EXIT_CODE && signal === null) {
          constructionContainmentSettled = true;
        }
      });
    },
    bindProxyIdentity: (identity: RecordedContainmentIdentity): void => {
      proxyMayExist = true;
      proxyIdentity = identity;
    },
    bindControl: (established: GuardianControlTeardown): void => {
      control = established;
    },
  });
}
