import { DirectoryLockOwnershipLostError, isDirectoryLockTimeoutError } from '../infra/fs-lock.js';
import type { Runtime } from '../runtime/ports.js';
import { CoralSetupError } from '../runtime/errors.js';
import {
  clearHandoffRoutingStoreQuarantine,
  HandoffRoutingStatusQuarantineCapacityError,
  MAX_HANDOFF_ROUTING_STATUS_QUARANTINES,
  quarantineHandoffRoutingStoreArtifact,
  type HandoffRoutingStatusQuarantineEntry,
} from '../store/handoff-routing-status-store.js';
import { acquireGenerationMaintenanceLease } from '../store/generation-mutation-coordination.js';
import { readHandoffRoutingStatus, type HandoffRoutingStatusReadResult } from './handoff-routing-status.js';

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
  | Readonly<{ kind: 'incomplete-quarantine'; quarantineId: string }>
  | Readonly<{ kind: 'quarantine-capacity-exhausted'; maximum: number }>
  | HandoffRoutingStatusMaintenanceRefusal;

export type HandoffRoutingStatusQuarantineClearResult =
  | Readonly<{ kind: 'cleared'; entry: HandoffRoutingStatusQuarantineEntry }>
  | Readonly<{ kind: 'quarantine-not-found'; quarantineId: string }>
  | HandoffRoutingStatusMaintenanceRefusal;

export interface HandoffRoutingStatusSocketGuard {
  release(): Promise<void>;
}

export type AcquireHandoffRoutingStatusSocketGuard = (options: {
  readonly socketPath: string;
  readonly flavor: Runtime['flavor'];
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
  if (error instanceof CoralSetupError && error.code === 'legacy_source_not_quiescent') {
    if (error.context?.writerObservation === 'unknown') {
      return {
        kind: 'generation-maintenance-unavailable',
        cause: 'writer-observation-unknown',
        holder: typeof error.context.holder === 'string' ? error.context.holder : '<writer-lease-holder>',
      };
    }
    return { kind: 'generation-maintenance-unavailable', cause: 'contended' };
  }
  if (error instanceof DirectoryLockOwnershipLostError) {
    return { kind: 'generation-maintenance-unavailable', cause: 'ownership-lost' };
  }
  return null;
}

export async function discardHandoffRoutingStatus(
  options: HandoffRoutingStatusOperatorOptions,
): Promise<HandoffRoutingStatusDiscardResult> {
  const { runtime, path } = options;
  const observedStatus = readHandoffRoutingStatus(runtime, path);
  if (observedStatus.kind !== 'unreadable' && observedStatus.kind !== 'unsupported-generation') {
    return { kind: 'refused', status: observedStatus };
  }

  const socketPath = runtime.paths.coral.coordinator.socketPath;
  let socket: HandoffRoutingStatusSocketGuard;
  try {
    socket = await options.acquireSocketGuard({
      socketPath,
      flavor: runtime.flavor,
      operation: 'routing-status discard',
      retryCommand: 'coral-cli backend routing-status discard',
    });
  } catch (error: unknown) {
    const refusal = operatorSocketRefusal(error, socketPath);
    if (refusal !== null) return refusal;
    throw error;
  }
  try {
    let maintenance: Awaited<ReturnType<typeof acquireGenerationMaintenanceLease>>;
    try {
      maintenance = await acquireGenerationMaintenanceLease(runtime);
    } catch (error: unknown) {
      const refusal = generationMaintenanceRefusal(error);
      if (refusal !== null) return refusal;
      throw error;
    }
    try {
      try {
        maintenance.assertOwned();
      } catch (error: unknown) {
        const refusal = generationMaintenanceRefusal(error);
        if (refusal !== null) return refusal;
        throw error;
      }
      const currentStatus = readHandoffRoutingStatus(runtime, path);
      if (currentStatus.kind !== 'unreadable' && currentStatus.kind !== 'unsupported-generation') {
        return { kind: 'refused', status: currentStatus };
      }
      try {
        maintenance.assertOwned();
      } catch (error: unknown) {
        const refusal = generationMaintenanceRefusal(error);
        if (refusal !== null) return refusal;
        throw error;
      }
      let quarantine: ReturnType<typeof quarantineHandoffRoutingStoreArtifact>;
      try {
        quarantine = quarantineHandoffRoutingStoreArtifact(runtime.storage, path, runtime.ids.uuid(), () =>
          maintenance.assertOwned(),
        );
      } catch (error: unknown) {
        if (error instanceof HandoffRoutingStatusQuarantineCapacityError) {
          return { kind: 'quarantine-capacity-exhausted', maximum: MAX_HANDOFF_ROUTING_STATUS_QUARANTINES };
        }
        const refusal = generationMaintenanceRefusal(error);
        if (refusal !== null) return refusal;
        throw error;
      }
      if (quarantine.kind === 'incomplete-quarantine') return quarantine;
      return {
        kind: 'discarded',
        artifactPath: path,
        quarantinePath: quarantine.quarantinePath,
        previousStatus: currentStatus,
      };
    } finally {
      maintenance.release();
    }
  } finally {
    await socket.release();
  }
}

export async function clearHandoffRoutingStatusQuarantine(
  options: HandoffRoutingStatusOperatorOptions,
  quarantineId: string,
): Promise<HandoffRoutingStatusQuarantineClearResult> {
  const { runtime, path } = options;
  const socketPath = runtime.paths.coral.coordinator.socketPath;
  let socket: HandoffRoutingStatusSocketGuard;
  try {
    socket = await options.acquireSocketGuard({
      socketPath,
      flavor: runtime.flavor,
      operation: 'routing-status quarantine clear',
      retryCommand: `coral-cli backend routing-status quarantine clear --id ${quarantineId}`,
    });
  } catch (error: unknown) {
    const refusal = operatorSocketRefusal(error, socketPath);
    if (refusal !== null) return refusal;
    throw error;
  }
  try {
    let maintenance: Awaited<ReturnType<typeof acquireGenerationMaintenanceLease>>;
    try {
      maintenance = await acquireGenerationMaintenanceLease(runtime);
    } catch (error: unknown) {
      const refusal = generationMaintenanceRefusal(error);
      if (refusal !== null) return refusal;
      throw error;
    }
    try {
      try {
        maintenance.assertOwned();
      } catch (error: unknown) {
        const refusal = generationMaintenanceRefusal(error);
        if (refusal !== null) return refusal;
        throw error;
      }
      let entry: HandoffRoutingStatusQuarantineEntry | null;
      try {
        entry = clearHandoffRoutingStoreQuarantine(runtime.storage, path, quarantineId, () =>
          maintenance.assertOwned(),
        );
      } catch (error: unknown) {
        const refusal = generationMaintenanceRefusal(error);
        if (refusal !== null) return refusal;
        throw error;
      }
      return entry === null ? { kind: 'quarantine-not-found', quarantineId } : { kind: 'cleared', entry };
    } finally {
      maintenance.release();
    }
  } finally {
    await socket.release();
  }
}
