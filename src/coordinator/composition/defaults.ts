declare const __PLUGIN_ROOT__: string;

import { createServer } from 'node:http';
import { join } from 'node:path';
import { readCoordinatorInfo, removeCoordinatorInfoIfOwner, writeCoordinatorInfo } from '../../infra/coordinator-discovery.js';
import { pluginRootNamespace } from "../../infra/plugin-identity.js";
import type { InvocationContext } from '../../runtime/invocation-context.js';
import { acquireLock, releaseLock, type BackendOwnershipState, type LockRecord, type VerifyBackendOwnershipFn } from '../lock.js';
import type { LaunchCoordinator } from '../live/admission.js';
import { IdleTimer, resolveIdleTimeoutMs } from '../live/idle.js';
import { createKbSubsystem as defaultCreateKbSubsystem } from '../../kb/subsystem.js';
import {
  cleanupStaleJobs,
  closeServer as defaultCloseServer,
  listen as defaultListen,
  markJobsAsError,
} from '../control.js';
import type { ProgressStore } from '../../jobs/job-store.js';
import type { Runtime } from '../../runtime/ports.js';
import * as discussRecovery from '../../discuss/shell/recovery.js';
import { ExecutionService as DefaultExecutionService } from '../execution-service.js';
import type { CoordinatorCoreOptions, CreateServerFn, FetchFn } from './types.js';

const LOCK_HEALTHCHECK_TIMEOUT_MS = 1_000;

type BackendEagerDefaults = {
  readonly resolvedPluginRoot: string;
  readonly createIdleTimer: NonNullable<CoordinatorCoreOptions['createIdleTimer']>;
  readonly createExecutionService: NonNullable<CoordinatorCoreOptions['createExecutionService']>;
  readonly verifyBackendOwnershipFn: NonNullable<CoordinatorCoreOptions['verifyBackendOwnershipFn']>;
  readonly acquireLockFn: NonNullable<CoordinatorCoreOptions['acquireLockFn']>;
  readonly writeBackendInfoFn: NonNullable<CoordinatorCoreOptions['writeBackendInfoFn']>;
  readonly removeBackendInfoIfOwnerFn: NonNullable<CoordinatorCoreOptions['removeBackendInfoIfOwnerFn']>;
  readonly removeLockIfOwnerFn: NonNullable<CoordinatorCoreOptions['removeLockIfOwnerFn']>;
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
  readonly progressStore: ProgressStore;
  readonly launchCoordinator: Pick<LaunchCoordinator, 'terminateAll'>;
  readonly log: (message: string) => void;
};

/**
 * Two-phase backend defaults plan. Eager defaults resolve from `runtime` only;
 * defaults that close over `bindHost`, `advertiseHost`, `progressStore`,
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

async function verifyBackendOwnershipWithHealthcheck(
  pluginRoot: string,
  record: LockRecord,
  runtime: Pick<Runtime, 'process' | 'storage' | 'time' | 'env' | 'paths'>,
  fetchFn: FetchFn,
): Promise<BackendOwnershipState> {
  const expectedNamespace = pluginRootNamespace(pluginRoot);
  const info = readCoordinatorInfo({ storage: runtime.storage, env: runtime.env, paths: runtime.paths });
  if (!info) {
    return 'stale';
  }
  if (
    info.instanceId !== record.instanceId ||
    info.pid !== record.pid ||
    info.bundleHash !== record.bundleHash ||
    info.flavor !== record.flavor ||
    info.namespace !== expectedNamespace
  ) {
    return 'stale';
  }
  if (!runtime.process.isAlive(record.pid)) {
    return 'stale';
  }

  const controller = new AbortController();
  const timeout = runtime.time.setTimeout(() => controller.abort(), LOCK_HEALTHCHECK_TIMEOUT_MS);

  try {
    const response = await fetchFn(`http://${info.host}:${info.port}/health`, {
      method: 'GET',
      headers: { 'X-Coral-Coordinator-Token': info.token },
      signal: controller.signal,
    });
    if (!response.ok) {
      return 'contended';
    }

    const body: unknown = await response.json();
    if (!body || typeof body !== 'object') {
      return 'contended';
    }

    const payload = body as Record<string, unknown>;
    return payload.status === 'ok' &&
      payload.bundleHash === record.bundleHash &&
      payload.flavor === record.flavor &&
      payload.instanceId === record.instanceId &&
      payload.namespace === expectedNamespace
      ? 'healthy'
      : 'contended';
  } catch {
    return 'contended';
  } finally {
    runtime.time.clearTimeout(timeout);
  }
}

function createDefaultBackendOwnershipVerifier(
  runtime: Pick<Runtime, 'process' | 'storage' | 'time' | 'env' | 'paths'>,
  fetchFn: FetchFn,
): VerifyBackendOwnershipFn {
  return ({ pluginRoot, record }) => verifyBackendOwnershipWithHealthcheck(pluginRoot, record, runtime, fetchFn);
}

export function resolveCoordinatorDefaults(
  options: CoordinatorCoreOptions,
  runtime: Runtime,
  pluginRoot?: string,
  progressStore?: ProgressStore,
): BackendDefaultsPlan {
  const resolvedPluginRoot = options.pluginRoot ?? resolveDefaultPluginRoot();
  if (pluginRoot !== undefined && pluginRoot !== resolvedPluginRoot) {
    throw new Error('resolveCoordinatorDefaults received a mismatched pluginRoot bridge input');
  }

  const createExecutionService: NonNullable<CoordinatorCoreOptions['createExecutionService']> =
    options.createExecutionService ?? ((ctx: InvocationContext, deps) => new DefaultExecutionService(ctx, deps));
  const fetchFn: FetchFn = options.fetchFn ?? ((url, init) => globalThis.fetch(url, init));
  const verifyBackendOwnershipFn =
    options.verifyBackendOwnershipFn ?? createDefaultBackendOwnershipVerifier(runtime, fetchFn);
  const acquireLockFn =
    options.acquireLockFn ??
    (async (_currentPluginRoot, instanceId, currentVersion, currentBundleHash, currentFlavor) => {
      await acquireLock(currentFlavor, currentBundleHash, {
        instanceId,
        version: currentVersion,
        runtime,
      });
    });
  const discoveryRuntime = { storage: runtime.storage, env: runtime.env, paths: runtime.paths };
  const writeBackendInfoFn =
    options.writeBackendInfoFn ?? ((info) => writeCoordinatorInfo(info, discoveryRuntime));
  const removeBackendInfoIfOwnerFn =
    options.removeBackendInfoIfOwnerFn ?? ((instanceId) => removeCoordinatorInfoIfOwner(instanceId, discoveryRuntime));
  const removeLockIfOwnerFn =
    options.removeLockIfOwnerFn ??
    ((_currentPluginRoot, instanceId) => releaseLock(instanceId, { storage: runtime.storage, paths: runtime.paths }));
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
    verifyBackendOwnershipFn,
    acquireLockFn,
    writeBackendInfoFn,
    removeBackendInfoIfOwnerFn,
    removeLockIfOwnerFn,
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
        throw new Error('Coordinator defaults plan already finalized');
      }
      finalized = true;

      if (progressStore !== undefined && progressStore !== bindings.progressStore) {
        throw new Error('resolveCoordinatorDefaults received a mismatched progressStore bridge input');
      }

      const listenFn =
        options.listenFn ?? ((server) => defaultListen(server, bindings.bindHost, bindings.advertiseHost));
      const cleanupStaleJobsFn =
        options.cleanupStaleJobsFn ??
        ((currentBundleHash: string) => {
          cleanupStaleJobs(bindings.progressStore, currentBundleHash, bindings.log, runtime.storage);
        });
      const markJobsAsErrorFn =
        options.markJobsAsErrorFn ??
        ((currentNamespace: string, message: string) => {
          markJobsAsError(bindings.progressStore, currentNamespace, message, runtime.storage);
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
