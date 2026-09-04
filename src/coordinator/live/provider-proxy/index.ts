import type { ProviderProxyOperationAuthority } from './operation-route.js';
import type { PublicationReceipt } from './set-publication.js';
import type { RecordedContainmentIdentity } from '../../../infra/process-containment.js';
import {
  handOverProviderProxyAcquisitionControlSession,
  providerProxyControlSessionOwner,
  type ProviderProxyAcquisitionSessionClosed,
  type ProviderProxyAcquisitionSessionEstablished,
  type ProviderProxyAcquisitionSessionHandedOver,
} from './control-session.js';

/**
 * Acquiring one guardian/reaper/proxy set.
 *
 * The whole module exists for its failure path. A half-built set is worse than none: it holds endpoints and
 * capsules, it may already have spawned a process group, and — because the enforcers arm on their own
 * clocks — it will eventually reap itself while the coordinator still believes it never existed. So every
 * step records what it created before it can fail, and one non-short-circuiting cleanup unwinds exactly
 * that record.
 */

type AcquisitionUndoAction = Readonly<{ label: string; run(): Promise<void> | void }>;

export type AcquisitionUndo =
  | (AcquisitionUndoAction & Readonly<{ kind?: 'ordinary' }>)
  | (AcquisitionUndoAction & Readonly<{ kind: 'guardian-containment'; guardianIdentity: RecordedContainmentIdentity }>)
  | (AcquisitionUndoAction & Readonly<{ kind: 'recovery-capability' }>);

export type ProviderProxyAcquisitionRecoveryOutcome =
  | Readonly<{ kind: 'absence-confirmed'; strandedArtifacts: readonly string[] }>
  | Readonly<{ kind: 'held'; reason: string }>;

export type ProviderProxyAcquisitionRecoveryCapability = Readonly<{
  retry(signal: AbortSignal): Promise<ProviderProxyAcquisitionRecoveryOutcome>;
}>;

export type ProviderProxyAcquisitionFailure = Readonly<{
  kind: 'provider_proxy_acquisition_failed';
  cut: string;
  reason: string;
  strandedArtifacts: readonly string[];
}>;

export type ProviderProxyAcquisitionHeld<Owner extends string> = Readonly<{
  kind: 'provider_proxy_acquisition_held';
  owner: Owner;
  cut: string;
  reason: string;
  strandedArtifacts: readonly string[];
  guardianIdentity: RecordedContainmentIdentity;
  recoveryCapability: ProviderProxyAcquisitionRecoveryCapability;
}>;

export type ProviderProxyAcquisitionResult =
  | Readonly<{
      kind: 'acquired';
      set: ProviderProxyOperationAuthority;
      publicationReceipt: PublicationReceipt;
    }>
  | ProviderProxyAcquisitionFailure
  | ProviderProxyAcquisitionHeld<'provider-host-acquisition'>
  | ProviderProxyAcquisitionSessionHandedOver<'provider-host-acquisition'>;

export type ProviderProxyControlEstablishmentDisposition =
  | (ProviderProxyAcquisitionSessionEstablished & Readonly<{ undo: AcquisitionUndo }>)
  | ProviderProxyAcquisitionSessionHandedOver<'acquisition'>
  | ProviderProxyAcquisitionSessionClosed;

/**
 * One acquisition attempt's steps, in order. Each returns the undo for what it created, so the record is
 * built by the same code that does the creating — a separate list would drift the first time a step changed.
 */
export interface ProviderProxyAcquisitionSteps {
  /** Writes the three one-use capsules. */
  createCapsules(): Promise<AcquisitionUndo>;
  /** Spawns the detached guardian, which in turn spawns the reaper and then the proxy. */
  spawnGuardian(): Promise<AcquisitionUndo>;
  /**
   * Opens and activates control on all three endpoints, checks the strict backend identities, and confirms
   * the containment the guardian recorded. Returns the authority only once every check has passed.
   */
  establishControl(
    registerUndo: (undo: AcquisitionUndo) => void,
    assertPublicationMayBegin: () => void,
  ): Promise<ProviderProxyControlEstablishmentDisposition>;
}

export type ProviderProxyAcquisitionOptions = Readonly<{
  steps: ProviderProxyAcquisitionSteps;
  /**
   * The initial acquisition and cleanup attempt share this budget. Expiry cannot discharge an unresolved
   * guardian; it returns a recovery capability to the next owner instead.
   */
  deadlineSignal: AbortSignal;
  onCleanupFailure?(label: string, error: unknown): void;
}>;

class PublicationDeadlineElapsedError extends Error {}

function failureReason(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}

/** Rejects once `deadlineSignal` aborts, and never otherwise. */
function deadlineElapsed(deadlineSignal: AbortSignal): Promise<never> {
  const reason = new Error('the acquisition deadline elapsed during cleanup');
  if (deadlineSignal.aborted) return Promise.reject(reason);
  return new Promise((_resolve, reject) => {
    deadlineSignal.addEventListener('abort', () => reject(reason), { once: true });
  });
}

/**
 * Runs one undo, bounded by the same deadline the whole acquisition attempt is bounded by.
 *
 * `run()` is invoked before the race. Deadline expiry bounds this attempt but is not proof that the undo
 * stopped or completed.
 */
function boundedUndo(undo: AcquisitionUndo, deadlineSignal: AbortSignal): Promise<void> {
  let attempt: Promise<void>;
  try {
    attempt = Promise.resolve(undo.run());
  } catch (error: unknown) {
    attempt = Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
  void attempt.catch(() => {});
  return Promise.race([attempt, deadlineElapsed(deadlineSignal)]);
}

/**
 * Runs every undo, newest first, without short-circuiting.
 *
 * Recovery capabilities are retained until guardian absence. Other actions still run newest first without
 * short-circuiting.
 */
async function unwind(
  undos: readonly AcquisitionUndo[],
  deadlineSignal: AbortSignal,
  onCleanupFailure: ((label: string, error: unknown) => void) | undefined,
): Promise<
  Readonly<{
    strandedArtifacts: readonly string[];
    hold: Readonly<{
      guardianIdentity: RecordedContainmentIdentity;
      recoveryCapability: ProviderProxyAcquisitionRecoveryCapability;
    }> | null;
  }>
> {
  const stranded: string[] = [];
  const recoveryUndos = undos.filter((undo) => undo.kind === 'recovery-capability');
  const cleanupUndos = undos.filter((undo) => undo.kind !== 'recovery-capability');
  let guardianHold: Extract<AcquisitionUndo, { kind: 'guardian-containment' }> | null = null;
  for (const undo of [...cleanupUndos].reverse()) {
    try {
      await boundedUndo(undo, deadlineSignal);
    } catch (error: unknown) {
      stranded.push(undo.label);
      onCleanupFailure?.(undo.label, error);
      if (undo.kind === 'guardian-containment') guardianHold = undo;
    }
  }
  if (guardianHold === null) {
    for (const undo of [...recoveryUndos].reverse()) {
      try {
        await boundedUndo(undo, deadlineSignal);
      } catch (error: unknown) {
        stranded.push(undo.label);
        onCleanupFailure?.(undo.label, error);
      }
    }
    return { strandedArtifacts: stranded, hold: null };
  }

  const guardianUndo = guardianHold;
  let retrying: Promise<ProviderProxyAcquisitionRecoveryOutcome> | null = null;
  const recoveryCapability: ProviderProxyAcquisitionRecoveryCapability = {
    retry(signal) {
      if (retrying !== null) return retrying;
      retrying = (async (): Promise<ProviderProxyAcquisitionRecoveryOutcome> => {
        try {
          await boundedUndo(guardianUndo, signal);
        } catch (error: unknown) {
          return { kind: 'held', reason: failureReason(error) };
        }
        const recoveryStranded: string[] = [];
        for (const undo of [...recoveryUndos].reverse()) {
          try {
            await boundedUndo(undo, signal);
          } catch {
            recoveryStranded.push(undo.label);
          }
        }
        return { kind: 'absence-confirmed', strandedArtifacts: recoveryStranded };
      })().finally(() => {
        retrying = null;
      });
      return retrying;
    },
  };
  return {
    strandedArtifacts: stranded,
    hold: { guardianIdentity: guardianUndo.guardianIdentity, recoveryCapability },
  };
}

/** A publication-unknown outcome must retain the exact recovery capsule and must not unwind its controls. */
export async function acquireProviderProxySet(
  options: ProviderProxyAcquisitionOptions,
): Promise<ProviderProxyAcquisitionResult> {
  const undos: AcquisitionUndo[] = [];

  const fail = async (
    cut: string,
    reason: string,
  ): Promise<ProviderProxyAcquisitionFailure | ProviderProxyAcquisitionHeld<'provider-host-acquisition'>> => {
    const cleanup = await unwind(undos, options.deadlineSignal, options.onCleanupFailure);
    if (cleanup.hold !== null) {
      return {
        kind: 'provider_proxy_acquisition_held',
        owner: 'provider-host-acquisition',
        cut,
        reason,
        strandedArtifacts: cleanup.strandedArtifacts,
        ...cleanup.hold,
      };
    }
    return {
      kind: 'provider_proxy_acquisition_failed',
      cut,
      reason,
      strandedArtifacts: cleanup.strandedArtifacts,
    };
  };

  const runCut = async <T>(
    cut: string,
    step: () => Promise<T>,
  ): Promise<T | ProviderProxyAcquisitionFailure | ProviderProxyAcquisitionHeld<'provider-host-acquisition'>> => {
    if (options.deadlineSignal.aborted) return fail(cut, 'the acquisition deadline elapsed');
    try {
      return await step();
    } catch (error: unknown) {
      return fail(
        error instanceof PublicationDeadlineElapsedError ? 'readiness publication' : cut,
        failureReason(error),
      );
    }
  };

  const isFailedCut = <T>(
    value: T | ProviderProxyAcquisitionFailure | ProviderProxyAcquisitionHeld<'provider-host-acquisition'>,
  ): value is ProviderProxyAcquisitionFailure | ProviderProxyAcquisitionHeld<'provider-host-acquisition'> =>
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    (value.kind === 'provider_proxy_acquisition_failed' || value.kind === 'provider_proxy_acquisition_held');

  const capsules = await runCut('capsule creation', () => options.steps.createCapsules());
  if (isFailedCut(capsules)) return capsules;
  undos.push(capsules);

  const spawned = await runCut('guardian spawn', () => options.steps.spawnGuardian());
  if (isFailedCut(spawned)) return spawned;
  undos.push(spawned);

  const control = await runCut('control establishment', () =>
    options.steps.establishControl(
      (undo) => undos.push(undo),
      () => {
        if (options.deadlineSignal.aborted) {
          throw new PublicationDeadlineElapsedError('the acquisition deadline elapsed before the set was published');
        }
      },
    ),
  );
  if (control.kind === 'provider_proxy_acquisition_failed' || control.kind === 'provider_proxy_acquisition_held') {
    return control;
  }
  if (control.kind === 'closed') return fail('control establishment', control.reason);
  if (control.kind === 'handed-over') {
    return handOverProviderProxyAcquisitionControlSession(
      control.session,
      providerProxyControlSessionOwner.providerHostAcquisition,
      control.incident,
    );
  }
  undos.push(control.undo);
  return { kind: 'acquired', set: control.set, publicationReceipt: control.publicationReceipt };
}
