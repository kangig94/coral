import type { Runtime } from '../runtime/ports.js';

type ReplacementBackendOwnershipCheckerInstaller = {
  install(): () => void;
};

type CreateReplacementBackendOwnershipCheckerContext = {
  readBackendInfo: (pluginRoot: string, runtime: Runtime) => { instanceId: string } | null;
  runtime: Runtime;
  runtimeState: { getLifecycle(): string };
  idleTimer: { isDraining: boolean; requestDrain(reason: string): void };
  pluginRoot: string;
  instanceId: string;
};

export function createReplacementBackendOwnershipChecker({
  readBackendInfo,
  runtime,
  runtimeState,
  idleTimer,
  pluginRoot,
  instanceId,
}: CreateReplacementBackendOwnershipCheckerContext): ReplacementBackendOwnershipCheckerInstaller {
  return {
    install(): () => void {
      const interval = runtime.time.setInterval(() => {
        if (runtimeState.getLifecycle() !== 'running' || idleTimer.isDraining) {
          return;
        }

        try {
          const current = readBackendInfo(pluginRoot, runtime);
          if (current?.instanceId !== instanceId) {
            teardown();
            idleTimer.requestDrain('replaced');
          }
        } catch {
          // read failure: skip this check
        }
      }, 30_000);
      interval.unref?.();

      let active = true;
      const teardown = (): void => {
        if (!active) {
          return;
        }
        active = false;
        runtime.time.clearInterval(interval);
      };

      return teardown;
    },
  };
}
