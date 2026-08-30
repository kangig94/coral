import { DirectoryLockOwnershipLostError, isDirectoryLockTimeoutError } from '../../infra/fs-lock.js';
import type { Runtime } from '../../runtime/ports.js';
import { CoralSetupError } from '../../runtime/errors.js';
import {
  clearHandoffRoutingStoreQuarantine,
  HandoffRoutingStatusQuarantineCapacityError,
  MAX_HANDOFF_ROUTING_STATUS_QUARANTINES,
  quarantineHandoffRoutingStoreArtifact,
  type HandoffRoutingStatusQuarantineClearStoreResult,
  type HandoffRoutingStatusQuarantineResult,
} from '../../store/handoff-routing-status-store.js';
import { acquireGenerationMaintenanceLease } from '../../store/generation-mutation-coordination.js';
import { readHandoffRoutingStatusForDiscard, type HandoffRoutingStatusReadResult } from './status.js';

type DiscardableRoutingStatus = Extract<
  HandoffRoutingStatusReadResult,
  { readonly kind: 'unreadable' | 'unsupported-generation' }
>;

type RefusedRoutingStatus = Exclude<HandoffRoutingStatusReadResult, DiscardableRoutingStatus>;

export type HandoffRoutingStatusMaintenanceRefusal =
  | Readonly<{ kind: 'coordinator-running'; socketPath: string }>
  | Readonly<{
      kind: 'coordinator-socket-unobservable';
      socketPath: string;
      cause: 'bind-failed' | 'directory-unverified';
    }>
  | Readonly<{ kind: 'coordinator-socket-insecure'; socketPath: string }>
  | Readonly<{
      kind: 'generation-maintenance-unavailable';
      cause: 'contended' | 'ownership-lost';
    }>
  | Readonly<{
      kind: 'generation-maintenance-unavailable';
      cause: 'writer-observation-unknown';
      holder: string;
    }>;

export type HandoffRoutingStatusDiscardResult =
  | Readonly<{
      kind: 'discarded';
      artifactPath: string;
      quarantinePath: string;
      previousStatus: DiscardableRoutingStatus;
    }>
  | Readonly<{ kind: 'refused'; status: RefusedRoutingStatus }>
  | Extract<HandoffRoutingStatusQuarantineResult, { kind: 'incomplete-quarantine' | 'quarantine-storage-failed' }>
  | Readonly<{ kind: 'quarantine-capacity-exhausted'; maximum: number }>
  | HandoffRoutingStatusMaintenanceRefusal;

export type HandoffRoutingStatusQuarantineClearResult =
  | HandoffRoutingStatusQuarantineClearStoreResult
  | HandoffRoutingStatusMaintenanceRefusal;

export interface HandoffRoutingStatusSocketGuard {
  release(): Promise<void>;
}

export type AcquireHandoffRoutingStatusSocketGuard = (options: {
  readonly runtime: Runtime;
  readonly operation: string;
  readonly retryCommand: string;
}) => Promise<HandoffRoutingStatusSocketGuard>;

export type HandoffRoutingStatusOperatorOptions = Readonly<{
  runtime: Runtime;
  path: string;
  acquireSocketGuard: AcquireHandoffRoutingStatusSocketGuard;
}>;

type OperatorSocketRefusal = Extract<
  HandoffRoutingStatusMaintenanceRefusal,
  { kind: 'coordinator-running' | 'coordinator-socket-unobservable' | 'coordinator-socket-insecure' }
>;

function operatorSocketRefusal(error: unknown, socketPath: string): OperatorSocketRefusal | null {
  if (!(error instanceof CoralSetupError)) return null;
  switch (error.code) {
    case 'coordinator_socket_in_use':
      return { kind: 'coordinator-running', socketPath };
    case 'coordinator_socket_bind_failed':
      return { kind: 'coordinator-socket-unobservable', socketPath, cause: 'bind-failed' };
    case 'coordinator_socket_dir_unverified':
      return { kind: 'coordinator-socket-unobservable', socketPath, cause: 'directory-unverified' };
    case 'coordinator_socket_dir_insecure':
      return { kind: 'coordinator-socket-insecure', socketPath };
    default:
      return null;
  }
}

function generationMaintenanceRefusal(
  error: unknown,
): Extract<HandoffRoutingStatusMaintenanceRefusal, { kind: 'generation-maintenance-unavailable' }> | null {
  if (isDirectoryLockTimeoutError(error)) {
    return { kind: 'generation-maintenance-unavailable', cause: 'contended' };
  }
  if (error instanceof CoralSetupError && error.code === 'legacy_source_writer_observation_unknown') {
    return {
      kind: 'generation-maintenance-unavailable',
      cause: 'writer-observation-unknown',
      holder: typeof error.context?.holder === 'string' ? error.context.holder : '<writer-lease-holder>',
    };
  }
  if (error instanceof CoralSetupError && error.code === 'legacy_source_not_quiescent') {
    return { kind: 'generation-maintenance-unavailable', cause: 'contended' };
  }
  if (error instanceof DirectoryLockOwnershipLostError) {
    return { kind: 'generation-maintenance-unavailable', cause: 'ownership-lost' };
  }
  return null;
}

type GenerationMaintenanceLease = Awaited<ReturnType<typeof acquireGenerationMaintenanceLease>>;

/**
 * A guard failure this module recognizes is returned as a refusal variant; anything else is thrown,
 * because an unrecognized failure is not a decline and must not read as one. Acquiring the lease
 * proves ownership only at that moment, so `run` must re-assert it around any step whose effect
 * outlives the assertion. Maintenance refusals are matched by error shape, so `run` must not let
 * another directory lock's timeout escape — it would be reported as maintenance contention.
 */
async function underOperatorGuards<T>(
  options: HandoffRoutingStatusOperatorOptions,
  invocation: Readonly<{ operation: string; retryCommand: string }>,
  run: (maintenance: GenerationMaintenanceLease) => T | Promise<T>,
): Promise<T | HandoffRoutingStatusMaintenanceRefusal> {
  const { runtime } = options;
  const socketPath = runtime.paths.coral.coordinator.socketPath;
  let socket: HandoffRoutingStatusSocketGuard;
  try {
    socket = await options.acquireSocketGuard({ runtime, ...invocation });
  } catch (error: unknown) {
    const refusal = operatorSocketRefusal(error, socketPath);
    if (refusal !== null) return refusal;
    throw error;
  }
  try {
    let maintenance: GenerationMaintenanceLease;
    try {
      maintenance = await acquireGenerationMaintenanceLease(runtime);
    } catch (error: unknown) {
      const refusal = generationMaintenanceRefusal(error);
      if (refusal !== null) return refusal;
      throw error;
    }
    try {
      return await run(maintenance);
    } catch (error: unknown) {
      const refusal = generationMaintenanceRefusal(error);
      if (refusal !== null) return refusal;
      throw error;
    } finally {
      maintenance.release();
    }
  } finally {
    await socket.release();
  }
}

export async function discardHandoffRoutingStatus(
  options: HandoffRoutingStatusOperatorOptions,
): Promise<HandoffRoutingStatusDiscardResult> {
  const { runtime, path } = options;
  const firstObservation = readHandoffRoutingStatusForDiscard(runtime, path);
  if (firstObservation.kind === 'undeterminable') {
    return { kind: 'refused', status: firstObservation.status };
  }
  const observedStatus = firstObservation.status;
  if (observedStatus.kind !== 'unreadable' && observedStatus.kind !== 'unsupported-generation') {
    return { kind: 'refused', status: observedStatus };
  }

  return underOperatorGuards(
    options,
    { operation: 'routing-status discard', retryCommand: 'coral-cli backend routing-status discard' },
    (maintenance): HandoffRoutingStatusDiscardResult => {
      maintenance.assertOwned();
      const guardedObservation = readHandoffRoutingStatusForDiscard(runtime, path);
      if (guardedObservation.kind === 'undeterminable') {
        return { kind: 'refused', status: guardedObservation.status };
      }
      const currentStatus = guardedObservation.status;
      if (currentStatus.kind !== 'unreadable' && currentStatus.kind !== 'unsupported-generation') {
        return { kind: 'refused', status: currentStatus };
      }
      maintenance.assertOwned();
      let quarantine: HandoffRoutingStatusQuarantineResult;
      try {
        quarantine = quarantineHandoffRoutingStoreArtifact(runtime.storage, path, runtime.ids.uuid(), () =>
          maintenance.assertOwned(),
        );
      } catch (error: unknown) {
        if (error instanceof HandoffRoutingStatusQuarantineCapacityError) {
          return { kind: 'quarantine-capacity-exhausted', maximum: MAX_HANDOFF_ROUTING_STATUS_QUARANTINES };
        }
        throw error;
      }
      if (quarantine.kind !== 'quarantined') return quarantine;
      return {
        kind: 'discarded',
        artifactPath: path,
        quarantinePath: quarantine.quarantinePath,
        previousStatus: currentStatus,
      };
    },
  );
}

export async function clearHandoffRoutingStatusQuarantine(
  options: HandoffRoutingStatusOperatorOptions,
  quarantineId: string,
): Promise<HandoffRoutingStatusQuarantineClearResult> {
  const { runtime, path } = options;
  return underOperatorGuards(
    options,
    {
      operation: 'routing-status quarantine clear',
      retryCommand: `coral-cli backend routing-status quarantine clear --id ${quarantineId}`,
    },
    (maintenance): HandoffRoutingStatusQuarantineClearStoreResult => {
      maintenance.assertOwned();
      return clearHandoffRoutingStoreQuarantine(runtime.storage, path, quarantineId, () => maintenance.assertOwned());
    },
  );
}
