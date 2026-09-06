import type { Capability } from '../../security/capability.js';
import {
  jobsAbortRpcSpec,
  providerProxySetContainBooleanRpcSpec,
  providerProxySetContainRpcSpec,
  transportOperationalCarveouts,
  type RequestBindingRule,
} from './catalog.js';
import { shutdownObligationAbandonMethod } from '../../obligation/shutdown-abandonment.js';

const [healthPath, shutdownPath, kbRestartPath, eventsStreamPath] = transportOperationalCarveouts;

type OperationalDispatchKind =
  | 'ping'
  | 'health'
  | 'event-stream'
  | 'shutdown'
  | 'shutdown-abandon'
  | 'kb-restart'
  | 'catalog';
type OperationalAuthentication = 'none' | 'principal';

type OperationalBaseSpec = {
  readonly id: string;
  readonly requires: Capability;
  readonly requestBinding?: RequestBindingRule;
  readonly requiresRunningLifecycle: boolean;
  readonly dispatch: { readonly kind: OperationalDispatchKind };
  readonly authentication: OperationalAuthentication;
};

export type HttpOperationalSpec = OperationalBaseSpec & {
  readonly transport: 'http';
  readonly http: {
    readonly method: 'GET' | 'POST';
    readonly path: (typeof transportOperationalCarveouts)[number];
    readonly variant?: 'default' | 'detailed';
  };
};

export type IpcOperationalSpec = OperationalBaseSpec & {
  readonly transport: 'ipc';
  readonly ipc: {
    readonly method:
      | 'transport.ping'
      | 'transport.health'
      | 'transport.shutdown'
      | typeof shutdownObligationAbandonMethod
      | 'transport.kb.restart'
      | typeof jobsAbortRpcSpec.name
      | typeof providerProxySetContainBooleanRpcSpec.name
      | typeof providerProxySetContainRpcSpec.name;
  };
};

export type OperationalRouteSpec = HttpOperationalSpec | IpcOperationalSpec;

export const operationalRouteSpecs: readonly OperationalRouteSpec[] = [
  {
    id: 'http.health.ping',
    transport: 'http',
    http: { method: 'GET', path: healthPath, variant: 'default' },
    requires: 'liveness',
    requiresRunningLifecycle: false,
    dispatch: { kind: 'ping' },
    authentication: 'none',
  },
  {
    id: 'http.health.detailed',
    transport: 'http',
    http: { method: 'GET', path: healthPath, variant: 'detailed' },
    requires: 'system:debug',
    requiresRunningLifecycle: false,
    dispatch: { kind: 'health' },
    authentication: 'principal',
  },
  {
    id: 'http.admin.shutdown',
    transport: 'http',
    http: { method: 'POST', path: shutdownPath },
    requires: 'system:shutdown',
    requiresRunningLifecycle: false,
    dispatch: { kind: 'shutdown' },
    authentication: 'principal',
  },
  {
    id: 'http.admin.kb.restart',
    transport: 'http',
    http: { method: 'POST', path: kbRestartPath },
    requires: 'system:shutdown',
    requiresRunningLifecycle: true,
    dispatch: { kind: 'kb-restart' },
    authentication: 'principal',
  },
  {
    id: 'http.events.stream',
    transport: 'http',
    http: { method: 'GET', path: eventsStreamPath },
    requires: 'jobs:read',
    requestBinding: { kind: 'projectRoot', projectRoot: 'optional-all-projects' },
    requiresRunningLifecycle: true,
    dispatch: { kind: 'event-stream' },
    authentication: 'principal',
  },
  {
    id: 'ipc.transport.ping',
    transport: 'ipc',
    ipc: { method: 'transport.ping' },
    requires: 'liveness',
    requiresRunningLifecycle: false,
    dispatch: { kind: 'ping' },
    authentication: 'none',
  },
  {
    id: 'ipc.transport.health',
    transport: 'ipc',
    ipc: { method: 'transport.health' },
    requires: 'system:debug',
    requiresRunningLifecycle: false,
    dispatch: { kind: 'health' },
    authentication: 'principal',
  },
  {
    id: 'ipc.transport.shutdown',
    transport: 'ipc',
    ipc: { method: 'transport.shutdown' },
    requires: 'system:shutdown',
    requiresRunningLifecycle: false,
    dispatch: { kind: 'shutdown' },
    authentication: 'principal',
  },
  {
    id: 'ipc.coordinator.shutdown-obligation.abandon',
    transport: 'ipc',
    ipc: { method: shutdownObligationAbandonMethod },
    requires: 'system:shutdown',
    requiresRunningLifecycle: false,
    dispatch: { kind: 'shutdown-abandon' },
    authentication: 'principal',
  },
  {
    id: 'ipc.transport.kb.restart',
    transport: 'ipc',
    ipc: { method: 'transport.kb.restart' },
    requires: 'system:shutdown',
    requiresRunningLifecycle: true,
    dispatch: { kind: 'kb-restart' },
    authentication: 'principal',
  },
  {
    id: 'ipc.jobs.abort.drain-recovery',
    transport: 'ipc',
    ipc: { method: jobsAbortRpcSpec.name },
    requires: jobsAbortRpcSpec.requires,
    requiresRunningLifecycle: false,
    dispatch: { kind: 'catalog' },
    authentication: 'principal',
  },
  {
    id: 'ipc.provider-proxy-set.contain.drain-recovery',
    transport: 'ipc',
    ipc: { method: providerProxySetContainRpcSpec.name },
    requires: providerProxySetContainRpcSpec.requires,
    requiresRunningLifecycle: false,
    dispatch: { kind: 'catalog' },
    authentication: 'principal',
  },
  {
    id: 'ipc.provider-proxy-set.contain-boolean.drain-recovery',
    transport: 'ipc',
    ipc: { method: providerProxySetContainBooleanRpcSpec.name },
    requires: providerProxySetContainBooleanRpcSpec.requires,
    requiresRunningLifecycle: false,
    dispatch: { kind: 'catalog' },
    authentication: 'principal',
  },
] as const;
