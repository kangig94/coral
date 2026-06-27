import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { BackendInfo } from '../../infra/backend-discovery.js';
import type { ProviderRegistry } from '../../providers/registry.js';
import type { InvocationContext } from '../../runtime/invocation-context.js';
import type {
  CoordinatorIdentity,
  MutableRuntimeState as MutableCoordinatorRuntimeState,
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
import type { KbJobRecorder } from '../../jobs/kb/recorder.js';
import type { Database } from '../../store/db.js';
import type { CoordinatorStoreServices, StoreServicesRef } from './store-services-ref.js';
import type { HealthSnapshot } from '../../transport/server-ports.js';
import type { KbDaemonSupervisor } from '../live/kb-daemon-supervisor.js';

export type CoordinatorBootSnapshot = {
  version?: string;
  bundleHash?: string;
  flavor?: 'prod' | 'dev';
  instanceId?: string;
  token?: string;
  shutdownToken?: string;
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
  registerBuiltInProvidersFn?: RegisterBuiltInProvidersFn;
  recoverPersistedDiscussFn?: RecoverPersistedDiscussFn;
  runStartupRecoveryFn: RunStartupRecoveryFn;
  providerHostManager?: ProviderHostManager;
  launchCoordinator?: LaunchCoordinator;
  eventBus?: TypedEventBus;
  providerRegistry?: ProviderRegistry;
  kbDaemonSupervisor: KbDaemonSupervisor;
  /**
   * Reports apply-bearing consumers (journal-apply or corpus) whose stop
   * has been requested but whose `inFlight` hasn't settled. Surfaces in
   * `/health.diagnostics.consumerStuck`. Cursor-only and stateless
   * consumers never appear here (no inflight after stop).
   */
  getConsumerStuck: () => NonNullable<NonNullable<HealthSnapshot['diagnostics']>['consumerStuck']>;
  getTextProjectionState?: () => HealthSnapshot['textProjectionState'];
  disposeLifecycleReactor?: () => void;
  onStopped?: () => void;
  onFatalShutdownError?: (error: unknown) => void;
  discussRegistry?: DiscussContextRegistry;
  /**
   * Discards a participant session's provider native log when a discussion fully
   * ends. Wired from the coordinator's lifecycle reactor; omitted in lightweight
   * harnesses (simulation, unit tests), where end-of-discussion cleanup is a no-op.
   */
  discardSessionArtifacts?: (sessionId: string) => Promise<void>;
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
  getExecutionService: (ctx: InvocationContext) => ProjectRequestPort;
  getRecoveryService: (ctx: InvocationContext) => RecoveryCapableService;
  listExecutionServices: () => ProjectRequestPort[];
  getDiscussStoreForSource: (source: string) => DiscussSessionStore;
  getDiscussContext: (ctx: InvocationContext) => DiscussContext;
  resolveProjectSource: (projectRoot: string) => string;
  isDrainRequested: () => boolean;
  requestDrain: (reason: string) => void;
  getKbJobRecorder: () => KbJobRecorder;
  hooks: LifecycleHooks;
};
