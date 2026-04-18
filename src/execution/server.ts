declare const __IS_CORAL_BACKEND_MAIN__: boolean | undefined;

import { registerBuiltInProviders } from '../providers/bootstrap.js';
import { backendLog } from '../shared/backend-log.js';
import { BackendAlreadyRunningError } from './backend-lock.js';
import {
  createBackendCore,
  type BackendCoreOptions,
  type BackendCoreResult,
} from './backend-core.js';
import { createRealRuntime } from '../runtime/real.js';
import type { Runtime, RuntimeObserver } from '../runtime/ports.js';
import { StartupInterruptedError } from './lifecycle.js';
import type { BackendServerInfo, LifecycleState } from './server-types.js';
import { handleSmokeOpenStore } from './smoke-open-store.js';
import {
  EventEmitterObserver,
  asEmittingRuntimeObserver,
  attachRecordingObserver,
  observeRuntimeSpawns,
  resolveSpawnRecordingDir,
} from './recording-observer.js';

export {
  createBackendCore,
  listInstantiatedExecutionServices,
  type BackendBootSnapshot,
  type BackendCoreOptions,
  type BackendCoreResult,
  type CreateServerFn,
} from './backend-core.js';

export type BackendServerOptions = Omit<BackendCoreOptions, 'runtime'> & {
  runtime?: Runtime;
  runtimeObserver?: RuntimeObserver;
};

export type BackendServerController = {
  server: BackendCoreResult['server'];
  start: () => Promise<BackendServerInfo>;
  shutdown: (reason: string) => Promise<void>;
  waitForShutdown: () => Promise<void>;
  getLifecycle: () => LifecycleState;
  getIdleTimer: () => BackendCoreResult['idleTimer'];
};

export function createBackendServer(options: BackendServerOptions = {}): BackendServerController {
  const {
    runtime: providedRuntime,
    runtimeObserver: providedRuntimeObserver,
    registerBuiltInProvidersFn,
    ...coreOptions
  } = options;
  const runtime = providedRuntime ?? createRealRuntime();
  const runtimeObserver = asEmittingRuntimeObserver(providedRuntimeObserver ?? new EventEmitterObserver());
  observeRuntimeSpawns(runtime, runtimeObserver);
  const recordingDir = resolveSpawnRecordingDir(runtime.env.get('CORAL_SIMULATE_RECORD'), runtime.env.cwd());
  if (recordingDir) {
    attachRecordingObserver({
      observer: runtimeObserver,
      runtime,
      recordingDir,
    });
  }
  const core = createBackendCore({
    ...coreOptions,
    runtime,
    registerBuiltInProvidersFn: registerBuiltInProvidersFn ?? registerBuiltInProviders,
  });

  return {
    server: core.server,
    start: () => core.lifecycleController.start(),
    shutdown: (reason) => core.lifecycleController.shutdown(reason),
    waitForShutdown: () => core.lifecycleController.waitForShutdown(),
    getLifecycle: () => core.runtimeState.getLifecycle(),
    getIdleTimer: () => core.idleTimer,
  };
}

export async function main(): Promise<number> {
  if (process.argv.includes('--smoke-open-store')) {
    return handleSmokeOpenStore(process.argv);
  }

  const backend = createBackendServer({
    onStopped: () => {
      process.exit(0);
    },
    onFatalShutdownError: (error) => {
      backendLog.error('Fatal shutdown error', error);
      process.exit(1);
    },
  });

  process.on('SIGTERM', () => {
    void backend.shutdown('sigterm').catch(() => {});
  });
  process.on('SIGINT', () => {
    void backend.shutdown('sigint').catch(() => {});
  });

  try {
    const info = await backend.start();
    backendLog.info(`Running on ${info.host}:${info.port}`);
    return 0;
  } catch (error: unknown) {
    if (error instanceof BackendAlreadyRunningError) {
      backendLog.info(error.message);
      return 0;
    }
    if (error instanceof StartupInterruptedError) {
      return 0;
    }

    backendLog.error('Fatal startup error', error);
    return 1;
  }
}

if (typeof __IS_CORAL_BACKEND_MAIN__ !== 'undefined' && __IS_CORAL_BACKEND_MAIN__) {
  void main()
    .then((code) => {
      if (code !== 0) {
        process.exit(code);
      }
    })
    .catch((error: unknown) => {
      backendLog.error('Fatal startup error', error);
      process.exit(1);
    });
}
