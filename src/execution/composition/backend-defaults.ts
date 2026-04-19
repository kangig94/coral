declare const __PLUGIN_ROOT__: string;

import { createServer } from 'node:http';
import { join } from 'node:path';
import { readBackendInfo, removeBackendInfoIfOwner, writeBackendInfo } from '../../coordinator/discovery.js';
import type { CallerContext } from '../../shared/request-context.js';
import { acquireLock, removeLockIfOwner, type BackendOwnershipState, type LockRecord, type VerifyBackendOwnershipFn } from '../backend-lock.js';
import type { LaunchCoordinator } from '../../coordinator/live/admission.js';
import { IdleTimer, resolveIdleTimeoutMs } from '../../coordinator/live/idle.js';
import { createKbSubsystem as defaultCreateKbSubsystem } from '../../kb/subsystem.js';
import {
  cleanupStaleJobs,
  closeServer as defaultCloseServer,
  listen as defaultListen,
  markJobsAsError,
} from '../../coordinator/control.js';
import type { ProgressStore } from '../progress-store.js';
import type { Runtime } from '../../runtime/ports.js';
import { discussReconcile } from '../../discuss/api.js';
import { ExecutionService as DefaultExecutionService } from '../../coordinator/api.js';
import type { BackendCoreOptions, CreateServerFn, FetchFn } from '../backend-core-types.js';

const LOCK_HEALTHCHECK_TIMEOUT_MS = 1_000;

type BackendEagerDefaults = {
  readonly resolvedPluginRoot: string;
  readonly createIdleTimer: NonNullable<BackendCoreOptions['createIdleTimer']>;
  readonly createExecutionService: NonNullable<BackendCoreOptions['createExecutionService']>;
  readonly verifyBackendOwnershipFn: NonNullable<BackendCoreOptions['verifyBackendOwnershipFn']>;
  readonly acquireLockFn: NonNullable<BackendCoreOptions['acquireLockFn']>;
  readonly writeBackendInfoFn: NonNullable<BackendCoreOptions['writeBackendInfoFn']>;
  readonly removeBackendInfoIfOwnerFn: NonNullable<BackendCoreOptions['removeBackendInfoIfOwnerFn']>;
  readonly removeLockIfOwnerFn: NonNullable<BackendCoreOptions['removeLockIfOwnerFn']>;
  readonly closeServerFn: NonNullable<BackendCoreOptions['closeServerFn']>;
  readonly createKbSubsystemFn: NonNullable<BackendCoreOptions['createKbSubsystemFn']>;
  readonly registerBuiltInProvidersFn: NonNullable<BackendCoreOptions['registerBuiltInProvidersFn']>;
  readonly recoverPersistedDiscussFn: NonNullable<BackendCoreOptions['recoverPersistedDiscussFn']>;
  readonly fetchFn: FetchFn;
  readonly createServerFn: CreateServerFn;
};

type BackendWorldBoundDefaults = {
  readonly listenFn: NonNullable<BackendCoreOptions['listenFn']>;
  readonly cleanupStaleJobsFn: NonNullable<BackendCoreOptions['cleanupStaleJobsFn']>;
  readonly markJobsAsErrorFn: NonNullable<BackendCoreOptions['markJobsAsErrorFn']>;
  readonly terminateAllFn: NonNullable<BackendCoreOptions['terminateAllFn']>;
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
 * those bindings come from `BackendWorld`.
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
  runtime: Pick<Runtime, 'process' | 'storage' | 'paths' | 'time'>,
  fetchFn: FetchFn,
): Promise<BackendOwnershipState> {
  const expectedNamespace = runtime.paths.pluginRootNamespace(pluginRoot);
  const info = readBackendInfo(pluginRoot, runtime);
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
      headers: { 'X-Coral-Backend-Token': info.token },
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
  runtime: Pick<Runtime, 'process' | 'storage' | 'paths' | 'time'>,
  fetchFn: FetchFn,
): VerifyBackendOwnershipFn {
  return ({ pluginRoot, record }) => verifyBackendOwnershipWithHealthcheck(pluginRoot, record, runtime, fetchFn);
}

export function resolveBackendDefaults(
  options: BackendCoreOptions,
  runtime: Runtime,
  pluginRoot?: string,
  progressStore?: ProgressStore,
): BackendDefaultsPlan {
  const resolvedPluginRoot = options.pluginRoot ?? resolveDefaultPluginRoot();
  if (pluginRoot !== undefined && pluginRoot !== resolvedPluginRoot) {
    throw new Error('resolveBackendDefaults received a mismatched pluginRoot bridge input');
  }

  const createExecutionService: NonNullable<BackendCoreOptions['createExecutionService']> =
    options.createExecutionService ?? ((ctx: CallerContext, deps) => new DefaultExecutionService(ctx, deps));
  const fetchFn: FetchFn = options.fetchFn ?? ((url, init) => globalThis.fetch(url, init));
  const verifyBackendOwnershipFn =
    options.verifyBackendOwnershipFn ?? createDefaultBackendOwnershipVerifier(runtime, fetchFn);
  const acquireLockFn =
    options.acquireLockFn ??
    ((currentPluginRoot, instanceId, currentVersion, currentBundleHash, currentFlavor) =>
      acquireLock(currentPluginRoot, instanceId, currentVersion, currentBundleHash, currentFlavor, {
        env: runtime.env,
        storage: runtime.storage,
        paths: runtime.paths,
        time: runtime.time,
        verifyOwnership: verifyBackendOwnershipFn,
      }));
  const writeBackendInfoFn =
    options.writeBackendInfoFn ?? ((currentPluginRoot, info) => writeBackendInfo(currentPluginRoot, info, runtime));
  const removeBackendInfoIfOwnerFn =
    options.removeBackendInfoIfOwnerFn ??
    ((currentPluginRoot, instanceId) => removeBackendInfoIfOwner(currentPluginRoot, instanceId, runtime));
  const removeLockIfOwnerFn =
    options.removeLockIfOwnerFn ??
    ((currentPluginRoot, instanceId) =>
      removeLockIfOwner(currentPluginRoot, instanceId, runtime.storage, runtime.paths));
  const closeServerFn = options.closeServerFn ?? defaultCloseServer;
  const createKbSubsystemFn = options.createKbSubsystemFn ?? defaultCreateKbSubsystem;
  const registerBuiltInProvidersFn = options.registerBuiltInProvidersFn ?? (() => {});
  const recoverPersistedDiscussFn = options.recoverPersistedDiscussFn ?? discussReconcile.runStartup;
  const createServerFn: CreateServerFn = options.createServerFn ?? createServer;
  const createIdleTimer: NonNullable<BackendCoreOptions['createIdleTimer']> =
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
        throw new Error('Backend defaults plan already finalized');
      }
      finalized = true;

      if (progressStore !== undefined && progressStore !== bindings.progressStore) {
        throw new Error('resolveBackendDefaults received a mismatched progressStore bridge input');
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
          markJobsAsError(bindings.progressStore, currentNamespace, message);
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
