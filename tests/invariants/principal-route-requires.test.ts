import { describe, expect, it } from 'vitest';
import type { Capability } from '#src/security/capability.js';
import { rpcCatalog } from '#src/transport/rpc/catalog.js';
import { operationalRouteSpecs } from '#src/transport/rpc/operational-catalog.js';
import { SUCCESSION_METHODS } from '#src/infra/succession-address.js';

const expectedRpcRequires = {
  'sessions.create': 'jobs:control',
  'workflow.run': 'jobs:control',
  'coordinator.recovery_quarantine.clear': 'system:debug',
  'coordinator.recovery_quarantine.discard_provider_operation': 'system:shutdown',
  'coordinator.provider_host.list': 'system:debug',
  'coordinator.provider_host.list.v2': 'system:debug',
  'coordinator.provider_host.inspect': 'system:debug',
  'coordinator.provider_host.evict': 'system:shutdown',
  'coordinator.provider_proxy_set.contain': 'system:shutdown',
  'coordinator.provider_proxy_set.contain.v2': 'system:shutdown',
  'coordinator.equipExpansion': 'expansion:manage',
  'coordinator.unequipExpansion': 'expansion:manage',
  'coordinator.removeExpansionCatalog': 'expansion:manage',
  'coordinator.listExpansion': 'expansion:manage',
  'coordinator.readBinding': 'expansion:manage',
  'jobs.abort': 'jobs:control',
  'jobs.list': 'jobs:read',
  'jobs.detail': 'jobs:read',
  'jobs.wait': 'jobs:read',
  'jobs.wait.snapshot': 'jobs:read',
  'discuss.persona.generate': 'discuss:participate',
  'discuss.session.create': 'discuss:participate',
  'discuss.session.list': 'discuss:participate',
  'discuss.session.detail': 'discuss:participate',
  'discuss.session.events': 'discuss:participate',
  'discuss.session.bid': 'discuss:participate',
  'discuss.session.speech': 'discuss:participate',
  'discuss.session.delete': 'discuss:participate',
  'kb.entries.search': 'kb:read',
  'kb.diagnose': 'kb:read',
  'kb.note.read': 'kb:read',
  'kb.note.create': 'kb:write',
  'kb.note.update': 'kb:write',
  'kb.note.delete': 'kb:write',
  'kb.source.list': 'kb:read',
  'kb.source.read': 'kb:read',
  'kb.source.create': 'kb:source:import',
  'kb.source.delete': 'kb:write',
  'kb.wiki.list': 'kb:read',
  'kb.wiki.read': 'kb:read',
  'kb.wiki.create': 'kb:write',
  'kb.wiki.rewrite': 'kb:write',
  'kb.wiki.link': 'kb:write',
  'kb.wiki.unlink': 'kb:write',
  'kb.wiki.cite': 'kb:write',
  'kb.wiki.adopt': 'kb:write',
  'kb.wiki.delete': 'kb:write',
  'kb.wake_up': 'kb:read',
  'kb.community.read': 'kb:read',
  'kb.community.list-stale': 'kb:read',
  'kb.community.summary-input': 'kb:read',
  'kb.community.set-summary': 'kb:write',
  'kb.memo.list': 'kb:read',
  'kb.memo.read': 'kb:read',
  'kb.memo.create': 'kb:write',
  'kb.memo.delete': 'kb:write',
  'kb.principles.list': 'kb:read',
  'kb.principle.read': 'kb:read',
  'kb.reindex': 'kb:write',
} as const satisfies Record<(typeof rpcCatalog)[number]['name'], Capability>;

type ExpectedOperationalRouteId =
  | 'http.health.ping'
  | 'http.health.detailed'
  | 'http.admin.shutdown'
  | 'http.admin.kb.restart'
  | 'http.events.stream'
  | 'ipc.transport.ping'
  | 'ipc.transport.challenge'
  | 'ipc.transport.health'
  | 'ipc.transport.shutdown'
  | 'ipc.transport.kb.restart'
  | `ipc.${(typeof SUCCESSION_METHODS)[keyof typeof SUCCESSION_METHODS]}`
  | 'ipc.jobs.abort.drain-recovery'
  | 'ipc.provider-host.list.drain-observation'
  | 'ipc.provider-host.list-v2.drain-observation'
  | 'ipc.provider-host.inspect.drain-observation'
  | 'ipc.provider-host.evict.drain-recovery'
  | 'ipc.provider-proxy-set.contain.drain-recovery'
  | 'ipc.provider-proxy-set.contain-boolean.drain-recovery';

type OperationalRouteSummary = {
  readonly transport: 'http' | 'ipc';
  readonly method: string;
  readonly path?: string;
  readonly variant?: 'default' | 'detailed';
  readonly requires: Capability;
  readonly requiresRunningLifecycle: boolean;
  readonly dispatchKind:
    | 'ping'
    | 'challenge'
    | 'health'
    | 'event-stream'
    | 'shutdown'
    | 'shutdown-abandon'
    | 'succession'
    | 'kb-restart'
    | 'catalog';
  readonly onRefusal?: 'spawn-successor' | 'report-refusal';
  readonly authentication: 'none' | 'principal';
};

const expectedOperationalSpecs = {
  'http.health.ping': {
    transport: 'http',
    method: 'GET',
    path: '/health',
    variant: 'default',
    requires: 'liveness',
    requiresRunningLifecycle: false,
    dispatchKind: 'ping',
    authentication: 'none',
  },
  'http.health.detailed': {
    transport: 'http',
    method: 'GET',
    path: '/health',
    variant: 'detailed',
    requires: 'system:debug',
    requiresRunningLifecycle: false,
    dispatchKind: 'health',
    authentication: 'principal',
  },
  'http.admin.shutdown': {
    transport: 'http',
    method: 'POST',
    path: '/admin/shutdown',
    requires: 'system:shutdown',
    requiresRunningLifecycle: false,
    dispatchKind: 'shutdown',
    authentication: 'principal',
  },
  'http.admin.kb.restart': {
    transport: 'http',
    method: 'POST',
    path: '/admin/kb/restart',
    requires: 'system:shutdown',
    requiresRunningLifecycle: true,
    dispatchKind: 'kb-restart',
    authentication: 'principal',
  },
  'http.events.stream': {
    transport: 'http',
    method: 'GET',
    path: '/events/stream',
    requires: 'jobs:read',
    requiresRunningLifecycle: true,
    dispatchKind: 'event-stream',
    authentication: 'principal',
  },
  'ipc.transport.ping': {
    transport: 'ipc',
    method: 'transport.ping',
    requires: 'liveness',
    requiresRunningLifecycle: false,
    dispatchKind: 'ping',
    authentication: 'none',
  },
  'ipc.transport.challenge': {
    transport: 'ipc',
    method: 'transport.challenge',
    requires: 'liveness',
    requiresRunningLifecycle: false,
    dispatchKind: 'challenge',
    authentication: 'none',
  },
  'ipc.transport.health': {
    transport: 'ipc',
    method: 'transport.health',
    requires: 'system:debug',
    requiresRunningLifecycle: false,
    dispatchKind: 'health',
    authentication: 'principal',
  },
  'ipc.transport.shutdown': {
    transport: 'ipc',
    method: 'transport.shutdown',
    requires: 'system:shutdown',
    requiresRunningLifecycle: false,
    dispatchKind: 'shutdown',
    authentication: 'principal',
  },
  'ipc.transport.kb.restart': {
    transport: 'ipc',
    method: 'transport.kb.restart',
    requires: 'system:shutdown',
    requiresRunningLifecycle: true,
    dispatchKind: 'kb-restart',
    authentication: 'principal',
  },
  'ipc.coordinator.succession.v1.request': {
    transport: 'ipc',
    method: SUCCESSION_METHODS.request,
    requires: 'system:shutdown',
    requiresRunningLifecycle: false,
    dispatchKind: 'succession',
    authentication: 'principal',
  },
  'ipc.coordinator.succession.v1.prepare': {
    transport: 'ipc',
    method: SUCCESSION_METHODS.prepare,
    requires: 'system:shutdown',
    requiresRunningLifecycle: false,
    dispatchKind: 'succession',
    authentication: 'principal',
  },
  'ipc.coordinator.succession.v1.commit': {
    transport: 'ipc',
    method: SUCCESSION_METHODS.commit,
    requires: 'system:shutdown',
    requiresRunningLifecycle: false,
    dispatchKind: 'succession',
    authentication: 'principal',
  },
  'ipc.coordinator.succession.v1.abort': {
    transport: 'ipc',
    method: SUCCESSION_METHODS.abort,
    requires: 'system:shutdown',
    requiresRunningLifecycle: false,
    dispatchKind: 'succession',
    authentication: 'principal',
  },
  'ipc.coordinator.succession.v1.status': {
    transport: 'ipc',
    method: SUCCESSION_METHODS.status,
    requires: 'system:shutdown',
    requiresRunningLifecycle: false,
    dispatchKind: 'succession',
    authentication: 'principal',
  },
  'ipc.jobs.abort.drain-recovery': {
    transport: 'ipc',
    method: 'jobs.abort',
    requires: 'jobs:control',
    requiresRunningLifecycle: false,
    dispatchKind: 'catalog',
    onRefusal: 'spawn-successor',
    authentication: 'principal',
  },
  'ipc.provider-host.list.drain-observation': {
    transport: 'ipc',
    method: 'coordinator.provider_host.list',
    requires: 'system:debug',
    requiresRunningLifecycle: false,
    dispatchKind: 'catalog',
    onRefusal: 'report-refusal',
    authentication: 'principal',
  },
  'ipc.provider-host.list-v2.drain-observation': {
    transport: 'ipc',
    method: 'coordinator.provider_host.list.v2',
    requires: 'system:debug',
    requiresRunningLifecycle: false,
    dispatchKind: 'catalog',
    onRefusal: 'report-refusal',
    authentication: 'principal',
  },
  'ipc.provider-host.inspect.drain-observation': {
    transport: 'ipc',
    method: 'coordinator.provider_host.inspect',
    requires: 'system:debug',
    requiresRunningLifecycle: false,
    dispatchKind: 'catalog',
    onRefusal: 'report-refusal',
    authentication: 'principal',
  },
  'ipc.provider-host.evict.drain-recovery': {
    transport: 'ipc',
    method: 'coordinator.provider_host.evict',
    requires: 'system:shutdown',
    requiresRunningLifecycle: false,
    dispatchKind: 'catalog',
    onRefusal: 'report-refusal',
    authentication: 'principal',
  },
  'ipc.provider-proxy-set.contain.drain-recovery': {
    transport: 'ipc',
    method: 'coordinator.provider_proxy_set.contain.v2',
    requires: 'system:shutdown',
    requiresRunningLifecycle: false,
    dispatchKind: 'catalog',
    onRefusal: 'spawn-successor',
    authentication: 'principal',
  },
  'ipc.provider-proxy-set.contain-boolean.drain-recovery': {
    transport: 'ipc',
    method: 'coordinator.provider_proxy_set.contain',
    requires: 'system:shutdown',
    requiresRunningLifecycle: false,
    dispatchKind: 'catalog',
    onRefusal: 'spawn-successor',
    authentication: 'principal',
  },
} as const satisfies Record<ExpectedOperationalRouteId, OperationalRouteSummary>;

function summarizeOperationalSpec(spec: (typeof operationalRouteSpecs)[number]): OperationalRouteSummary {
  const base = {
    requires: spec.requires,
    requiresRunningLifecycle: spec.requiresRunningLifecycle,
    dispatchKind: spec.dispatch.kind,
    ...(spec.dispatch.kind === 'catalog' ? { onRefusal: spec.dispatch.onRefusal } : {}),
    authentication: spec.authentication,
  };

  if (spec.transport === 'http') {
    const summary: OperationalRouteSummary = {
      transport: spec.transport,
      method: spec.http.method,
      path: spec.http.path,
      ...base,
    };
    if (spec.http.variant !== undefined) {
      return { ...summary, variant: spec.http.variant };
    }
    return summary;
  }

  return {
    transport: spec.transport,
    method: spec.ipc.method,
    ...base,
  };
}

describe('principal route capability requirements', () => {
  it('declares a valid capability for every executable RPC catalog route', () => {
    const actual = Object.fromEntries(rpcCatalog.map((spec) => [spec.name, spec.requires]));

    expect(actual).toEqual(expectedRpcRequires);
  });

  it('declares requirements and local dispatch semantics for operational routes', () => {
    const actual = Object.fromEntries(operationalRouteSpecs.map((spec) => [spec.id, summarizeOperationalSpec(spec)]));

    expect(actual).toEqual(expectedOperationalSpecs);
  });
});
