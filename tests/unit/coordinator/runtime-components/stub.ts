import type {
  RuntimeComponent,
  RuntimeComponentId,
  RuntimeComponentStatus,
  DegradedReason,
} from '#src/coordinator/runtime-components/contract.js';

export const runtimeComponentPhase = {
  initializing(id: RuntimeComponentId, attempt: number): RuntimeComponentStatus {
    return { id, phase: 'initializing', attempt };
  },
  online(id: RuntimeComponentId): RuntimeComponentStatus {
    return { id, phase: 'online' };
  },
  degraded(id: RuntimeComponentId, reason: DegradedReason): RuntimeComponentStatus {
    return { id, phase: 'degraded', reason };
  },
  offline(id: RuntimeComponentId, reason: string, lastLogLine?: string): RuntimeComponentStatus {
    return lastLogLine === undefined ? { id, phase: 'offline', reason } : { id, phase: 'offline', reason, lastLogLine };
  },
};

export function createStubRuntimeComponent(opts: {
  id: RuntimeComponentId;
  initialPhase: RuntimeComponentStatus;
}): RuntimeComponent {
  let status: RuntimeComponentStatus = opts.initialPhase;
  const transition = (next: RuntimeComponentStatus): void => {
    status = next;
  };
  return {
    id: opts.id,
    get status() {
      return status;
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
