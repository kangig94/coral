import type { KnowledgeBaseRuntime } from '../../kb/subsystem.js';
import { KB_ID, SubsystemUnavailableError, type Subsystem, type SubsystemStatus } from '../subsystems/contract.js';
import type { KbChildHealthSnapshot, KbChildSupervisor } from './supervisor.js';

function statusFromChild(snapshot: KbChildHealthSnapshot): SubsystemStatus {
  if (!snapshot.enabled || snapshot.phase === 'disabled') {
    return {
      id: KB_ID,
      phase: 'offline',
      reason: snapshot.reason ?? 'KB child runtime is disabled.',
      diagnostic: { retry: 'restart-daemon' },
    };
  }

  if (snapshot.phase === 'online') {
    return { id: KB_ID, phase: 'online' };
  }

  if (snapshot.phase === 'starting' || snapshot.phase === 'restarting' || snapshot.phase === 'stopping') {
    return { id: KB_ID, phase: 'initializing', attempt: snapshot.generation };
  }

  return {
    id: KB_ID,
    phase: 'offline',
    reason: snapshot.lastError ?? snapshot.reason ?? `KB child runtime is ${snapshot.phase}.`,
    ...(snapshot.lastError === undefined
      ? {}
      : {
          diagnostic: {
            retry: 'restart-daemon' as const,
            lastErrorStack: snapshot.lastError,
          },
        }),
  };
}

export function createKbChildProxySubsystem(kbChildSupervisor: KbChildSupervisor): Subsystem<KnowledgeBaseRuntime> {
  return {
    id: KB_ID,
    get status() {
      return statusFromChild(kbChildSupervisor.read());
    },
    async init() {
      // The lifecycle owns starting the child supervisor. This subsystem only
      // mirrors child health into the existing subsystem registry contract.
    },
    async dispose() {
      // Child disposal is handled by the daemon shutdown finalizer.
    },
    resource() {
      throw new SubsystemUnavailableError(KB_ID, 'offline');
    },
    onStatusChange: () => () => {},
  };
}
