import type { KbDaemonHealthSnapshot, KbDaemonSupervisor } from '../live/kb-daemon-supervisor.js';
import { KB_COMPONENT_ID, type RuntimeComponent, type RuntimeComponentStatus } from './contract.js';

function statusFromDaemon(snapshot: KbDaemonHealthSnapshot): RuntimeComponentStatus {
  if (!snapshot.enabled || snapshot.phase === 'disabled') {
    return {
      id: KB_COMPONENT_ID,
      phase: 'offline',
      reason: snapshot.reason ?? 'KB daemon runtime is disabled.',
      diagnostic: { retry: 'restart-daemon' },
    };
  }

  if (snapshot.phase === 'online') {
    return { id: KB_COMPONENT_ID, phase: 'online' };
  }

  if (snapshot.phase === 'starting' || snapshot.phase === 'restarting' || snapshot.phase === 'stopping') {
    return { id: KB_COMPONENT_ID, phase: 'initializing', attempt: snapshot.generation };
  }

  return {
    id: KB_COMPONENT_ID,
    phase: 'offline',
    reason: snapshot.lastError ?? snapshot.reason ?? `KB daemon runtime is ${snapshot.phase}.`,
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

export function createKbDaemonHealthComponent(kbDaemonSupervisor: KbDaemonSupervisor): RuntimeComponent {
  return {
    id: KB_COMPONENT_ID,
    get status() {
      return statusFromDaemon(kbDaemonSupervisor.read());
    },
    async init() {
      // The lifecycle owns starting the daemon supervisor. This component only
      // mirrors daemon health into the runtime component registry.
    },
    async dispose() {
      // Disposal is handled by the daemon shutdown finalizer.
    },
  };
}
