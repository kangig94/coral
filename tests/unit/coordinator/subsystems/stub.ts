import type { Subsystem, SubsystemId, SubsystemStatus, DegradedReason } from '#src/coordinator/subsystems/contract.js';
import { SubsystemUnavailableError } from '#src/coordinator/subsystems/contract.js';

export const subsystemPhase = {
  initializing(id: SubsystemId, attempt: number): SubsystemStatus {
    return { id, phase: 'initializing', attempt };
  },
  online(id: SubsystemId): SubsystemStatus {
    return { id, phase: 'online' };
  },
  degraded(id: SubsystemId, reason: DegradedReason): SubsystemStatus {
    return { id, phase: 'degraded', reason };
  },
  offline(id: SubsystemId, reason: string, lastLogLine?: string): SubsystemStatus {
    return lastLogLine === undefined
      ? { id, phase: 'offline', reason }
      : { id, phase: 'offline', reason, lastLogLine };
  },
};

export function createStubSubsystem<R>(opts: {
  id: SubsystemId;
  initialPhase: SubsystemStatus;
  resource?: R;
}): Subsystem<R> {
  let status: SubsystemStatus = opts.initialPhase;
  const listeners = new Set<(s: SubsystemStatus) => void>();
  const transition = (next: SubsystemStatus): void => {
    status = next;
    for (const l of listeners) l(next);
  };
  return {
    id: opts.id,
    get status() {
      return status;
    },
    resource(): R {
      if (status.phase === 'online' || status.phase === 'degraded') {
        if (opts.resource === undefined) throw new Error(`stub subsystem ${opts.id} has no resource`);
        return opts.resource;
      }
      throw new SubsystemUnavailableError(opts.id, status.phase);
    },
    onStatusChange(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    init(): Promise<void> {
      // No-op — initial phase is already set
      return Promise.resolve();
    },
    dispose(): Promise<void> {
      transition({ id: opts.id, phase: 'offline', reason: 'disposed' });
      return Promise.resolve();
    },
  };
}
