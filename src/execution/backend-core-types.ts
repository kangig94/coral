import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { BackendInfo } from '../infra/backend-info.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { CallerContext } from '../shared/request-context.js';
import type {
  BackendIdentity,
  ExecutionServiceLike,
  MutableBackendRuntimeState,
} from './backend-contracts.js';
import type { VerifyBackendOwnershipFn } from './backend-lock.js';
import type { DiscussContext } from './discuss/context.js';
import type { DiscussContextRegistry } from './discuss/context-registry.js';
import type { DiscussSessionStore } from './discuss/session-store.js';
import type { LaunchCoordinator } from './engine.js';
import type { TypedEventBus } from './event-bus.js';
import type { ProviderHostManager } from './host-manager.js';
import type { IdleTimer } from './idle-timer.js';
import type {
  CreateKbSubsystemFn,
  LifecycleController,
  LifecycleHooks,
  RecoverPersistedDiscussFn,
  RegisterBuiltInProvidersFn,
} from './lifecycle.js';
import type { ProgressStore } from './progress-store.js';
import type { Runtime } from './runtime.js';
import type { ExecutionServiceDeps, RecoveryCapableService } from './service.js';
import type { SessionIndex } from './session-index.js';

export type BackendBootSnapshot = {
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
type RemoveLockIfOwnerFn = (pluginRoot: string, instanceId: string) => void;

export type BackendCoreOptions = {
  runtime: Runtime;
  bootSnapshot?: BackendBootSnapshot;
  progressStore?: ProgressStore;
  pluginRoot?: string;
  backendNamespace?: string;
  resolveProjectSourceFn?: (projectRoot: string) => string;
  createServerFn?: CreateServerFn;
  fetchFn?: FetchFn;
  listenFn?: (server: Server) => Promise<{ port: number; host: string }>;
  createIdleTimer?: () => IdleTimer;
  createExecutionService?: (ctx: CallerContext, deps: ExecutionServiceDeps) => ExecutionServiceLike;
  verifyBackendOwnershipFn?: VerifyBackendOwnershipFn;
  acquireLockFn?: (
    pluginRoot: string,
    instanceId: string,
    version: string,
    bundleHash: string,
    flavor: 'prod' | 'dev',
  ) => Promise<void>;
  writeBackendInfoFn?: (pluginRoot: string, info: BackendInfo) => void;
  removeBackendInfoIfOwnerFn?: (pluginRoot: string, instanceId: string) => void;
  removeLockIfOwnerFn?: RemoveLockIfOwnerFn;
  closeServerFn?: (server: Server) => Promise<void>;
  cleanupStaleJobsFn?: (currentBundleHash: string) => void;
  markJobsAsErrorFn?: (namespace: string, message: string) => void;
  terminateAllFn?: () => void;
  createKbSubsystemFn?: CreateKbSubsystemFn;
  registerBuiltInProvidersFn?: RegisterBuiltInProvidersFn;
  recoverPersistedDiscussFn?: RecoverPersistedDiscussFn;
  providerHostManager?: ProviderHostManager;
  launchCoordinator?: LaunchCoordinator;
  eventBus?: TypedEventBus;
  providerRegistry?: ProviderRegistry;
  onStopped?: () => void;
  onFatalShutdownError?: (error: unknown) => void;
  discussRegistry?: DiscussContextRegistry;
};

export type BackendCoreResult = {
  identity: BackendIdentity;
  server: Server;
  handleRequest: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  lifecycleController: LifecycleController;
  sessionIndex: SessionIndex;
  idleTimer: IdleTimer;
  discussRegistry: DiscussContextRegistry;
  runtimeState: MutableBackendRuntimeState;
  progressStore: ProgressStore;
  eventBus: TypedEventBus;
  launchCoordinator: LaunchCoordinator;
  providerRegistry: ProviderRegistry;
  providerHostManager: ProviderHostManager;
  getExecutionService: (ctx: CallerContext) => ExecutionServiceLike;
  getRecoveryService: (ctx: CallerContext) => RecoveryCapableService;
  listExecutionServices: () => ExecutionServiceLike[];
  getDiscussStoreForSource: (source: string) => DiscussSessionStore;
  getDiscussContext: (ctx: CallerContext) => DiscussContext;
  resolveProjectSource: (projectRoot: string) => string;
  isDrainRequested: () => boolean;
  requestDrain: (reason: string) => void;
  hooks: LifecycleHooks;
};
