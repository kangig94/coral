import type { Capability } from '../../security/capability.js';
import {
  jobsAbortRpcSpec,
  providerHostEvictRpcSpec,
  providerHostInspectRpcSpec,
  providerHostListRpcSpec,
  providerHostListV2RpcSpec,
  providerProxySetContainBooleanRpcSpec,
  providerProxySetContainRpcSpec,
  transportOperationalCarveouts,
  type RequestBindingRule,
} from './catalog.js';

const [healthPath, shutdownPath, kbRestartPath, eventsStreamPath] = transportOperationalCarveouts;

type OperationalDispatchKind = 'ping' | 'health' | 'event-stream' | 'shutdown' | 'kb-restart' | 'catalog';
type OperationalAuthentication = 'none' | 'principal';

/** What a refused answer means for the caller. Declared per route, beside the route. */
type RouteRefusalDisposition = 'spawn-successor' | 'report-refusal';

type OperationalDispatch =
  | Readonly<{ kind: Exclude<OperationalDispatchKind, 'catalog'> }>
  | Readonly<{ kind: 'catalog'; onRefusal: RouteRefusalDisposition }>;

type OperationalBaseSpec = {
  readonly id: string;
  readonly requires: Capability;
  readonly requestBinding?: RequestBindingRule;
  readonly requiresRunningLifecycle: boolean;
  readonly dispatch: OperationalDispatch;
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
      | 'transport.kb.restart'
      | typeof jobsAbortRpcSpec.name
      | typeof providerProxySetContainBooleanRpcSpec.name
      | typeof providerProxySetContainRpcSpec.name
      | typeof providerHostListRpcSpec.name
      | typeof providerHostListV2RpcSpec.name
      | typeof providerHostInspectRpcSpec.name
      | typeof providerHostEvictRpcSpec.name;
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
    dispatch: { kind: 'catalog', onRefusal: 'spawn-successor' },
    authentication: 'principal',
  },
  // A successor has not captured the incumbent's provider-host owners, so its answer is not the incumbent's,
  // and it cannot discharge an eviction: all four routes report the refusal instead of spawning one.
  {
    id: 'ipc.provider-host.list.drain-observation',
    transport: 'ipc',
    ipc: { method: providerHostListRpcSpec.name },
    requires: providerHostListRpcSpec.requires,
    requiresRunningLifecycle: false,
    dispatch: { kind: 'catalog', onRefusal: 'report-refusal' },
    authentication: 'principal',
  },
  {
    id: 'ipc.provider-host.list-v2.drain-observation',
    transport: 'ipc',
    ipc: { method: providerHostListV2RpcSpec.name },
    requires: providerHostListV2RpcSpec.requires,
    requiresRunningLifecycle: false,
    dispatch: { kind: 'catalog', onRefusal: 'report-refusal' },
    authentication: 'principal',
  },
  {
    id: 'ipc.provider-host.inspect.drain-observation',
    transport: 'ipc',
    ipc: { method: providerHostInspectRpcSpec.name },
    requires: providerHostInspectRpcSpec.requires,
    requiresRunningLifecycle: false,
    dispatch: { kind: 'catalog', onRefusal: 'report-refusal' },
    authentication: 'principal',
  },
  {
    id: 'ipc.provider-host.evict.drain-recovery',
    transport: 'ipc',
    ipc: { method: providerHostEvictRpcSpec.name },
    requires: providerHostEvictRpcSpec.requires,
    requiresRunningLifecycle: false,
    dispatch: { kind: 'catalog', onRefusal: 'report-refusal' },
    authentication: 'principal',
  },
  {
    id: 'ipc.provider-proxy-set.contain.drain-recovery',
    transport: 'ipc',
    ipc: { method: providerProxySetContainRpcSpec.name },
    requires: providerProxySetContainRpcSpec.requires,
    requiresRunningLifecycle: false,
    dispatch: { kind: 'catalog', onRefusal: 'spawn-successor' },
    authentication: 'principal',
  },
  {
    id: 'ipc.provider-proxy-set.contain-boolean.drain-recovery',
    transport: 'ipc',
    ipc: { method: providerProxySetContainBooleanRpcSpec.name },
    requires: providerProxySetContainBooleanRpcSpec.requires,
    requiresRunningLifecycle: false,
    dispatch: { kind: 'catalog', onRefusal: 'spawn-successor' },
    authentication: 'principal',
  },
] as const;

function isIpcOperationalSpec(spec: OperationalRouteSpec): spec is IpcOperationalSpec {
  return spec.transport === 'ipc';
}

const IPC_OPERATIONAL_SPECS: readonly IpcOperationalSpec[] = operationalRouteSpecs.filter(isIpcOperationalSpec);

export function readIpcOperationalSpec(method: string): IpcOperationalSpec | null {
  return IPC_OPERATIONAL_SPECS.find((spec) => spec.ipc.method === method) ?? null;
}

export type RouteLifecycleAdmission = 'running' | 'running-or-draining';

/** Derived, not hand-listed: on IPC, admitted-while-draining ⟺ requiresRunningLifecycle === false. */
export function ipcRouteLifecycleAdmission(method: string): RouteLifecycleAdmission {
  const spec = readIpcOperationalSpec(method);
  if (spec === null) {
    return 'running';
  }
  return spec.requiresRunningLifecycle ? 'running' : 'running-or-draining';
}

/** A method with no catalog dispatch has no successor that could discharge it, so its refusal is reported. */
export function ipcRouteRefusalDisposition(method: string): RouteRefusalDisposition {
  const dispatch = readIpcOperationalSpec(method)?.dispatch;
  return dispatch?.kind === 'catalog' ? dispatch.onRefusal : 'report-refusal';
}
