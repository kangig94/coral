import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { BackendInfo } from '../../infra/backend-discovery.js';
import type { ProviderRegistry } from '../../providers/registry.js';
import type { InvocationContext } from '../../runtime/invocation-context.js';
import type {
  CoordinatorIdentity,
  MutableRuntimeState as MutableCoordinatorRuntimeState,
  CreateKbSubsystemFn,
  LifecycleController,
  LifecycleHooks,
  RecoverPersistedDiscussFn,
  RegisterBuiltInProvidersFn,
  RunStartupRecoveryFn,
} from '../lifecycle.js';
import type { ProjectRequestPort, ExecutionServiceDeps } from '../contracts.js';
import type { DiscussContext } from '../../discuss/shell/types.js';
import type { DiscussContextRegistry } from '../../discuss/shell/live-registry.js';
import type { DiscussSessionStore } from '../../discuss/shell/session-store.js';
import type { TypedEventBus } from '../event-bus.js';

import type { LaunchCoordinator } from '../live/admission.js';
import type { ProviderHostManager } from '../live/provider-hosts/index.js';
import type { IdleTimer } from '../live/idle.js';
import type { Runtime } from '../../runtime/ports.js';
import type { RecoveryCapableService } from '../../jobs/reconcile/contracts.js';
import type { IpcListener } from '../../transport/ipc/server.js';
import type { ExpansionLifecycleService } from '../expansion/lifecycle.js';
import type { KbSourceImportReadinessWaiter } from '../services/kb/source-import.js';
import type { Database } from '../../store/db.js';
import type { CoordinatorStoreServices, StoreServicesRef } from './store-services-ref.js';

export type { CoordinatorStoreServices, StoreServicesRef } from './store-services-ref.js';

export type CoordinatorBootSnapshot = {
  version?: string;
  bundleHash?: string;
  flavor?: 'prod' | 'dev';
  instanceId?: string;
  token?: string;
  now?: () => number;
  log?: (message: string) => void;
  bindHost?: string;
  advertiseHost?: string;
  pid?: number;
};

export type CreateServerFn = (handler: (req: IncomingMessage, res: ServerResponse) => void) => Server;
export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export type CoordinatorCoreOptions = {
  runtime: Runtime;
  bootSnapshot?: CoordinatorBootSnapshot;
  pluginRoot?: string;
  backendNamespace?: string;
  resolveProjectSourceFn?: (projectRoot: string) => string;
  createServerFn?: CreateServerFn;
  fetchFn?: FetchFn;
  listenFn?: (server: Server) => Promise<{ port: number; host: string }>;
  listenIpcFn?: (listener: IpcListener) => Promise<{ socketPath: string }>;
  createIdleTimer?: () => IdleTimer;
  createExecutionService?: (ctx: InvocationContext, deps: ExecutionServiceDeps) => ProjectRequestPort;
  writeBackendInfoFn?: (info: BackendInfo) => void;
  removeBackendInfoIfOwnerFn?: (instanceId: string) => void;
  closeServerFn?: (server: Server) => Promise<void>;
  cleanupStaleJobsFn?: (currentBundleHash: string) => void;
  markJobsAsErrorFn?: (namespace: string, message: string) => void;
  createStoreServicesFromDbFn?: (storeDb: Database) => CoordinatorStoreServices;
  terminateAllFn?: () => void;
  /**
   * Subsystem factory for KB. Coordinator wraps the user-facing legacy
   * build factory into this shape; composition forwards it to
   * `LifecycleDeps.createKbSubsystemFn`.
   */
  createKbSubsystemFn?: CreateKbSubsystemFn;
  registerBuiltInProvidersFn?: RegisterBuiltInProvidersFn;
  recoverPersistedDiscussFn?: RecoverPersistedDiscussFn;
  runStartupRecoveryFn: RunStartupRecoveryFn;
  providerHostManager?: ProviderHostManager;
  launchCoordinator?: LaunchCoordinator;
  eventBus?: TypedEventBus;
  providerRegistry?: ProviderRegistry;
  waitForKbSourceImportReadiness?: KbSourceImportReadinessWaiter;
  /**
   * Reports apply-bearing consumers (journal-apply or corpus) whose stop
   * has been requested but whose `inFlight` hasn't settled. Surfaces in
   * `/health.diagnostics.consumerStuck`. Cursor-only and stateless
   * consumers never appear here (no inflight after stop).
   */
  getConsumerStuck: () => Array<{ id: string; elapsedSinceStopMs: number }>;
  /**
   * Reports the mutation lock state when a deadline has aborted a
   * mutation but `fn` has not yet settled. Wired against
   * `kbRuntime.mutationLockDiagnostics()`.
   */
  getMutationBlocked: () => { blocked: false } | { blocked: true; owner: string; ageMs: number; signaledAtMs: number };
  onStopped?: () => void;
  onFatalShutdownError?: (error: unknown) => void;
  discussRegistry?: DiscussContextRegistry;
};

export type CoordinatorCoreResult = {
  identity: CoordinatorIdentity;
  server: Server;
  handleRequest: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  lifecycleController: LifecycleController;
  idleTimer: IdleTimer;
  discussRegistry: DiscussContextRegistry;
  runtimeState: MutableCoordinatorRuntimeState;
  storeServicesRef: StoreServicesRef;
  eventBus: TypedEventBus;
  launchCoordinator: LaunchCoordinator;
  providerRegistry: ProviderRegistry;
  providerHostManager: ProviderHostManager;
  expansionLifecycleService: ExpansionLifecycleService | null;
  getExecutionService: (ctx: InvocationContext) => ProjectRequestPort;
  getRecoveryService: (ctx: InvocationContext) => RecoveryCapableService;
  listExecutionServices: () => ProjectRequestPort[];
  getDiscussStoreForSource: (source: string) => DiscussSessionStore;
  getDiscussContext: (ctx: InvocationContext) => DiscussContext;
  resolveProjectSource: (projectRoot: string) => string;
  isDrainRequested: () => boolean;
  requestDrain: (reason: string) => void;
  hooks: LifecycleHooks;
};
