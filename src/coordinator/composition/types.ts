import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { BackendInfo } from '../../infra/backend-discovery.js';
import type { ProviderRegistry } from '../../providers/registry.js';
import type { HostAdmissionCollection } from '../../providers/host-admission.js';
import type { InvocationContext } from '../../runtime/invocation-context.js';
import type {
  CoordinatorIdentity,
  MutableRuntimeState as MutableCoordinatorRuntimeState,
  LifecycleController,
  LifecycleHooks,
  RecoverPersistedDiscussFn,
  RegisterBuiltInProvidersFn,
} from '../lifecycle.js';
import type { ProjectRequestPort, ExecutionServiceDeps } from '../contracts.js';
import type { DiscussContext } from '../../discuss/shell/types.js';
import type { DiscussContextRegistry } from '../../discuss/shell/live-registry.js';
import type { DiscussSessionStore } from '../../discuss/shell/session-store.js';
import type { TypedEventBus } from '../event-bus.js';

import type { LaunchCoordinator } from '../live/admission.js';
import type { ProviderHostManager } from '../live/provider-hosts/index.js';
import type { ProviderEventHandler } from '../../provider-proxy/control-client.js';
import type { LocalOperationRegistry } from '../services/operation-registry.js';
import type { IdleTimer } from '../live/idle.js';
import type { Runtime } from '../../runtime/ports.js';
import type { RecoveryCapableService } from '../../jobs/reconcile/contracts.js';
import type { IpcListener, ListenIpcServerResult } from '../../transport/ipc/server.js';
import type { KbJobRecorder } from '../../jobs/kb/recorder.js';
import type { Database } from '../../store/db.js';
import type { CoordinatorStoreServices, StoreServicesRef } from './store-services-ref.js';
import type { HealthSnapshot } from '../../transport/server-ports.js';
import type { KbDaemonSupervisor } from '../live/kb-daemon-supervisor.js';
import type { ProviderScope } from '../../infra/provider-scope.js';
import type { StoreFormatDescription } from '../../store/format-fingerprint.js';

type CoordinatorBootSnapshot = {
  version?: string;
  buildSetId?: string;
  bundleHash?: string;
  flavor?: 'prod' | 'dev';
  instanceId?: string;
  token?: string;
  bootToken?: string;
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
  storeFormat: StoreFormatDescription;
  bootSnapshot?: CoordinatorBootSnapshot;
  pluginRoot?: string;
  backendNamespace?: string;
  resolveProjectSourceFn?: (projectRoot: string) => string;
  createServerFn?: CreateServerFn;
  fetchFn?: FetchFn;
  listenFn?: (server: Server) => Promise<{ port: number; host: string }>;
  listenIpcFn?: (
    listener: IpcListener,
    additionalCompatibilitySocketPaths?: readonly string[],
  ) => Promise<ListenIpcServerResult>;
  createIdleTimer?: () => IdleTimer;
  createExecutionService?: (ctx: InvocationContext, deps: ExecutionServiceDeps) => ProjectRequestPort;
  writeBackendInfoFn?: (info: BackendInfo) => void;
  removeBackendInfoIfOwnerFn?: (instanceId: string) => void;
  closeServerFn?: (server: Server) => Promise<void>;
  cleanupStaleJobsFn?: (currentBundleHash: string) => void | Promise<void>;
  markJobsAsErrorFn?: (message: string) => void | Promise<void>;
  createStoreServicesFromDbFn?: (storeDb: Database) => CoordinatorStoreServices;
  terminateAllFn?: () => void;
  registerBuiltInProvidersFn?: RegisterBuiltInProvidersFn;
  recoverPersistedDiscussFn?: RecoverPersistedDiscussFn;
  providerHostManager?: ProviderHostManager;
  providerHostAdmission?: HostAdmissionCollection;
  /**
   * Builds the durable-effect handler for a proxy's `provider.event.v1` pushes (W2.3), fresh, once per proxy
   * set acquisition — never an already-built handler, because this option is consumed while composing
   * `providerHostManager` (`world.ts`), before the store exists; the handler itself needs the store, and by
   * the time an acquisition actually runs (lazily, on first app-server session for that executable identity)
   * the store is certainly open. Absent in every composition that does not wire proxy event application
   * (every test, and any coordinator build with W2.3 disabled).
   */
  buildProviderEventHandler?: () => ProviderEventHandler;
  /**
   * This coordinator generation's live app-server operations (W2.3). Constructed unconditionally in
   * `coordinator/index.ts`, alongside `buildProviderEventHandler`, and passed through here for the same
   * reason: `world.ts` is where a live proxy set's routing capability (`ProviderHostManager`) and this
   * registry both need to reach `execution-services.ts`. Defaults to a fresh, empty instance when absent —
   * every test that does not construct a coordinator through `coordinator/index.ts`.
   */
  operationRegistry?: LocalOperationRegistry;
  launchCoordinator?: LaunchCoordinator;
  eventBus?: TypedEventBus;
  providerRegistry?: ProviderRegistry;
  systemProviderScope?: Extract<ProviderScope, { origin: 'system' }>;
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
  systemProviderScope?: Extract<ProviderScope, { origin: 'system' }>;
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
