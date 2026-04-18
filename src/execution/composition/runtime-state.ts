import type { MutableBackendRuntimeState } from '../backend-contracts.js';
import type { KnowledgeBaseRuntime } from '../kb-tools.js';
import type { LifecycleState } from '../server-types.js';

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
