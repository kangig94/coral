declare const __PLUGIN_ROOT__: string;

import { createServer } from 'node:http';
import { join } from 'node:path';
import { removeBackendInfoIfOwner, writeBackendInfo } from '../../infra/backend-discovery.js';
import type { InvocationContext } from '../../runtime/invocation-context.js';
import type { LaunchCoordinator } from '../live/admission.js';
import { IdleTimer, resolveIdleTimeoutMs } from '../live/idle.js';
import { createKbSubsystem as defaultCreateKbSubsystem } from '../../kb/subsystem.js';
import {
  cleanupStaleJobs,
  closeServer as defaultCloseServer,
  listen as defaultListen,
  markJobsAsError,
} from '../lifecycle.js';
import type { JobStore } from '../../jobs/store.js';
import * as discussRecovery from '../../discuss/shell/recovery.js';
import { ExecutionService as DefaultExecutionService } from '../execution-service.js';
import type { CoordinatorCoreOptions, CreateServerFn, FetchFn } from './types.js';

type BackendEagerDefaults = {
  readonly resolvedPluginRoot: string;
  readonly createIdleTimer: NonNullable<CoordinatorCoreOptions['createIdleTimer']>;
  readonly createExecutionService: NonNullable<CoordinatorCoreOptions['createExecutionService']>;
  readonly writeBackendInfoFn: NonNullable<CoordinatorCoreOptions['writeBackendInfoFn']>;
  readonly removeBackendInfoIfOwnerFn: NonNullable<CoordinatorCoreOptions['removeBackendInfoIfOwnerFn']>;
  readonly closeServerFn: NonNullable<CoordinatorCoreOptions['closeServerFn']>;
  readonly createKbSubsystemFn: NonNullable<CoordinatorCoreOptions['createKbSubsystemFn']>;
  readonly registerBuiltInProvidersFn: NonNullable<CoordinatorCoreOptions['registerBuiltInProvidersFn']>;
  readonly recoverPersistedDiscussFn: NonNullable<CoordinatorCoreOptions['recoverPersistedDiscussFn']>;
  readonly fetchFn: FetchFn;
  readonly createServerFn: CreateServerFn;
};

type BackendWorldBoundDefaults = {
  readonly listenFn: NonNullable<CoordinatorCoreOptions['listenFn']>;
  readonly cleanupStaleJobsFn: NonNullable<CoordinatorCoreOptions['cleanupStaleJobsFn']>;
  readonly markJobsAsErrorFn: NonNullable<CoordinatorCoreOptions['markJobsAsErrorFn']>;
  readonly terminateAllFn: NonNullable<CoordinatorCoreOptions['terminateAllFn']>;
};

export type ResolvedBackendDefaults = BackendEagerDefaults & BackendWorldBoundDefaults;

export type BackendDefaultsBindings = {
  readonly bindHost: string;
  readonly advertiseHost?: string;
  readonly getProgressStore: () => JobStore | null;
  readonly launchCoordinator: Pick<LaunchCoordinator, 'terminateAll'>;
  readonly log: (message: string) => void;
};

/**
 * Two-phase backend defaults plan. Eager defaults resolve from `runtime` only;
 * defaults that close over `bindHost`, `advertiseHost`, store services,
 * `launchCoordinator`, or `log` belong in `finalizeWithWorld(...)` because
 * those bindings come from `CoordinatorWorld`.
 */
export interface BackendDefaultsPlan {
  readonly eager: BackendEagerDefaults;
  finalizeWithWorld(bindings: BackendDefaultsBindings): ResolvedBackendDefaults;
}

function resolveDefaultPluginRoot(): string {
  return typeof __PLUGIN_ROOT__ === 'string' ? __PLUGIN_ROOT__ : join(__dirname, '..', '..', '..');
}

export function resolveCoordinatorDefaults(
  options: CoordinatorCoreOptions,
  runtime: CoordinatorCoreOptions['runtime'],
  pluginRoot?: string,
): BackendDefaultsPlan {
  const resolvedPluginRoot = options.pluginRoot ?? resolveDefaultPluginRoot();
  if (pluginRoot !== undefined && pluginRoot !== resolvedPluginRoot) {
    throw new Error('resolveCoordinatorDefaults received a mismatched pluginRoot bridge input');
  }

  const createExecutionService: NonNullable<CoordinatorCoreOptions['createExecutionService']> =
    options.createExecutionService ?? ((ctx: InvocationContext, deps) => new DefaultExecutionService(ctx, deps));
  const fetchFn: FetchFn = options.fetchFn ?? ((url, init) => globalThis.fetch(url, init));
  const discoveryRuntime = { storage: runtime.storage, env: runtime.env, paths: runtime.paths };
  const writeBackendInfoFn = options.writeBackendInfoFn ?? ((info) => writeBackendInfo(info, discoveryRuntime));
  const removeBackendInfoIfOwnerFn =
    options.removeBackendInfoIfOwnerFn ?? ((instanceId) => removeBackendInfoIfOwner(instanceId, discoveryRuntime));
  const closeServerFn = options.closeServerFn ?? defaultCloseServer;
  const createKbSubsystemFn = options.createKbSubsystemFn ?? defaultCreateKbSubsystem;
  const registerBuiltInProvidersFn = options.registerBuiltInProvidersFn ?? (() => {});
  const recoverPersistedDiscussFn = options.recoverPersistedDiscussFn ?? discussRecovery.runStartup;
  const createServerFn: CreateServerFn = options.createServerFn ?? createServer;
  const createIdleTimer: NonNullable<CoordinatorCoreOptions['createIdleTimer']> =
    options.createIdleTimer ??
    (() =>
      new IdleTimer({
        time: runtime.time,
        timeoutMs: resolveIdleTimeoutMs(runtime.env.get('CORAL_BACKEND_IDLE_MS')),
      }));

  const eager: BackendEagerDefaults = {
    resolvedPluginRoot,
    createIdleTimer,
    createExecutionService,
    writeBackendInfoFn,
    removeBackendInfoIfOwnerFn,
    closeServerFn,
    createKbSubsystemFn,
    registerBuiltInProvidersFn,
    recoverPersistedDiscussFn,
    fetchFn,
    createServerFn,
  };

  let finalized = false;

  return {
    eager,
    finalizeWithWorld(bindings) {
      if (finalized) {
        throw new Error('Backend defaults plan already finalized');
      }
      finalized = true;

      const listenFn =
        options.listenFn ?? ((server) => defaultListen(server, bindings.bindHost, bindings.advertiseHost));
      const cleanupStaleJobsFn =
        options.cleanupStaleJobsFn ??
        ((currentBundleHash: string) => {
          const progressStore = bindings.getProgressStore();
          if (progressStore === null) return;
          cleanupStaleJobs(progressStore, currentBundleHash, bindings.log, runtime.storage);
        });
      const markJobsAsErrorFn =
        options.markJobsAsErrorFn ??
        ((currentNamespace: string, message: string) => {
          const progressStore = bindings.getProgressStore();
          if (progressStore === null) return;
          markJobsAsError(
            progressStore,
            currentNamespace,
            message,
            runtime.storage,
            runtime.paths.coral.exports.jobsRoot,
          );
        });
      const terminateAllFn = options.terminateAllFn ?? (() => bindings.launchCoordinator.terminateAll());

      return {
        ...eager,
        listenFn,
        cleanupStaleJobsFn,
        markJobsAsErrorFn,
        terminateAllFn,
      };
    },
  };
}
