declare const __PLUGIN_ROOT__: string;

import { createServer } from 'node:http';
import { join } from 'node:path';
import { removeBackendInfoIfOwner, writeBackendInfo } from '../../infra/backend-discovery.js';
import type { InvocationContext } from '../../runtime/invocation-context.js';
import type { LaunchCoordinator } from '../live/admission.js';
import { IdleTimer, resolveIdleTimeoutMs } from '../live/idle.js';
import {
  cleanupStaleJobs,
  closeServer as defaultCloseServer,
  listen as defaultListen,
  markJobsAsError,
  resolveJobRetentionMs,
  type CurateAssistantFactory,
} from '../lifecycle.js';
import type { JobStore } from '../../jobs/store.js';
import * as discussRecovery from '../../discuss/shell/recovery.js';
import { ExecutionService as DefaultExecutionService } from '../execution-service.js';
import type { CoordinatorCoreOptions, CreateServerFn, FetchFn } from './types.js';
import type { KnowledgeBaseRuntime } from '../../kb/subsystem.js';
import type { Subsystem, SubsystemStatus } from '../subsystems/contract.js';
import { KB_ID, SubsystemUnavailableError } from '../subsystems/contract.js';

// Mirrors the idle KB default: production wires the real Claude-backed factory
// through `createCoordinatorServer`. The fallback is never invoked on the
// default (idle KB) path; if it ever is, it fails loudly rather than silently
// no-op'ing a curation request.
const defaultIdleCurateAssistant: CurateAssistantFactory = () => ({
  async complete() {
    throw new Error('Curate assistant is not configured; the real factory is wired by createCoordinatorServer.');
  },
});

const defaultIdleKbSubsystem = (): Subsystem<KnowledgeBaseRuntime> => {
  const status: SubsystemStatus = { id: KB_ID, phase: 'initializing', attempt: 0 };
  return {
    id: KB_ID,
    get status() {
      return status;
    },
    resource: () => {
      throw new SubsystemUnavailableError(KB_ID, 'initializing');
    },
    onStatusChange: () => () => {},
    init: async () => {},
    dispose: async () => {},
  };
};

type BackendEagerDefaults = {
  readonly resolvedPluginRoot: string;
  readonly createIdleTimer: NonNullable<CoordinatorCoreOptions['createIdleTimer']>;
  readonly createExecutionService: NonNullable<CoordinatorCoreOptions['createExecutionService']>;
  readonly writeBackendInfoFn: NonNullable<CoordinatorCoreOptions['writeBackendInfoFn']>;
  readonly removeBackendInfoIfOwnerFn: NonNullable<CoordinatorCoreOptions['removeBackendInfoIfOwnerFn']>;
  readonly closeServerFn: NonNullable<CoordinatorCoreOptions['closeServerFn']>;
  readonly createKbSubsystemFn: NonNullable<CoordinatorCoreOptions['createKbSubsystemFn']>;
  readonly createCurateAssistant: NonNullable<CoordinatorCoreOptions['createCurateAssistant']>;
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
  // Production wires `createKbSubsystemFn` through `createCoordinatorServer`,
  // which always overrides this default. The fallback exists for tests that
  // call `createCoordinatorCore` directly without registering KB — it
  // returns a Subsystem that never transitions out of `initializing`, so
  // KB-routed handlers cleanly produce `kb_initializing` envelopes.
  const createKbSubsystemFn: NonNullable<CoordinatorCoreOptions['createKbSubsystemFn']> =
    options.createKbSubsystemFn ?? defaultIdleKbSubsystem;
  const createCurateAssistant: NonNullable<CoordinatorCoreOptions['createCurateAssistant']> =
    options.createCurateAssistant ?? defaultIdleCurateAssistant;
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
    createCurateAssistant,
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
      const jobRetentionMs = resolveJobRetentionMs(runtime.env.get('CORAL_JOBS_RETENTION_DAYS'));
      const cleanupStaleJobsFn =
        options.cleanupStaleJobsFn ??
        ((currentBundleHash: string) => {
          const progressStore = bindings.getProgressStore();
          if (progressStore === null) return;
          cleanupStaleJobs(progressStore, currentBundleHash, bindings.log, runtime.storage, runtime.time.now(), jobRetentionMs);
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
