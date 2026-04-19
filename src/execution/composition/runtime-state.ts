import type { MutableRuntimeState as MutableBackendRuntimeState, LifecycleState } from '../../coordinator/control.js';
import type { KnowledgeBaseRuntime } from '../../kb/subsystem.js';


export function createRuntimeState(startedAt: number): MutableBackendRuntimeState {
  let lifecycle: LifecycleState = 'starting';
  let currentStartedAt = startedAt;
  let kbSubsystem: KnowledgeBaseRuntime | null = null;
  let kbInitError: string | null = null;
  let launchFenceActive = false;

  return {
    getLifecycle: () => lifecycle,
    getStartedAt: () => currentStartedAt,
    getKbSubsystem: () => kbSubsystem,
    getKbInitError: () => kbInitError,
    getLaunchFenceActive: () => launchFenceActive,
    setLifecycle: (state) => {
      lifecycle = state;
    },
    setStartedAt: (ts) => {
      currentStartedAt = ts;
    },
    setKbSubsystem: (kb) => {
      kbSubsystem = kb;
    },
    setKbInitError: (error) => {
      kbInitError = error;
    },
    setLaunchFenceActive: (active) => {
      launchFenceActive = active;
    },
  };
}
