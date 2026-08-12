import { z, type ZodType } from 'zod';
import type { Capability } from '../../security/capability.js';
import {
  equipExpansionRequestSchema,
  listExpansionRequestSchema,
  readBindingRequestSchema,
  removeExpansionCatalogRequestSchema,
  unequipExpansionRequestSchema,
} from '../../expansion/rpc-contract.js';
import { discussSeedSchema } from '../../discuss/command-schemas.js';
import {
  discussSessionBidRequestSchema,
  discussSessionCreateRequestSchema,
  discussSessionDeleteRequestSchema,
  discussSessionDetailRequestSchema,
  discussSessionEventsRequestSchema,
  discussSessionListRequestSchema,
  discussSessionSpeechRequestSchema,
} from './discuss.js';
import { jobAbortSchema, jobDetailRequestSchema, jobsListRequestSchema, jobWaitSchema } from './jobs.js';
import {
  kbCommunityListStaleRequestSchema,
  kbCommunityReadRequestSchema,
  kbCommunitySetSummaryRequestSchema,
  kbCommunitySummaryInputRequestSchema,
  kbDiagnoseRequestSchema,
  kbEntriesRequestSchema,
  kbMemoCreateRequestSchema,
  kbMemoDeleteRequestSchema,
  kbMemoListQuerySchema,
  kbMemoReadRequestSchema,
  kbNoteCreateRequestSchema,
  kbNoteDeleteRequestSchema,
  kbNoteReadRequestSchema,
  kbNoteUpdateRequestSchema,
  kbPrincipleReadRequestSchema,
  kbPrinciplesListRequestSchema,
  kbReindexRequestSchema,
  kbSourceCreateRequestSchema,
  kbSourceDeleteRequestSchema,
  kbSourceListRequestSchema,
  kbSourceReadRequestSchema,
  kbWakeUpRequestSchema,
  kbWikiAdoptRequestSchema,
  kbWikiCiteRequestSchema,
  kbWikiCreateRequestSchema,
  kbWikiDeleteRequestSchema,
  kbWikiLinkRequestSchema,
  kbWikiListRequestSchema,
  kbWikiReadRequestSchema,
  kbWikiRewriteRequestSchema,
  kbWikiUnlinkRequestSchema,
} from '../../kb/tool-contracts.js';
import { sessionCreateSchema } from '../../sessions/command-schemas.js';
import type { RpcPorts } from './ports.js';
import { workflowRequestSchema } from './workflow.js';
import { hostRefSchema } from '../../providers/host-ref-schema.js';
import { providerHostInventoryRecordSchema } from '../../providers/host-inventory-schema.js';

export interface RpcMethodSpec<Req, _Res> {
  readonly name: string;
  readonly kind: 'unary' | 'subscription';
  readonly requires: Capability;
  readonly requestBinding?: RequestBindingRule;
  readonly requestSchema: ZodType<Req>;
  readonly responseSchema?: ZodType<_Res>;
  readonly responseKind: 'json' | 'notification-stream';
  readonly portKey: keyof RpcPorts;
  readonly http: {
    readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE';
    readonly path: string;
    readonly queryShape?: 'bare' | 'keyed';
  };
}

export type RequestBindingRule = {
  readonly kind: 'projectRoot';
  readonly projectRoot: 'required' | 'optional-all-projects';
};

export const recoveryQuarantineClearRequestSchema = z
  .object({
    boundary: z.string().min(1, 'Recovery boundary is required'),
    key: z.string().min(1, 'Recovery subject key is required'),
    revision: z.string().min(1, 'Recovery subject revision is required').nullable(),
  })
  .strict();

export const recoveryQuarantineClearResultSchema = recoveryQuarantineClearRequestSchema
  .extend({
    disposition: z.enum(['advanced', 'quarantined', 'continuation']),
  })
  .strict();

export const providerHostInventoryRowSchema = providerHostInventoryRecordSchema
  .extend({
    ownerId: z.string().min(1),
  })
  .strict();

export const providerHostListRequestSchema = z.object({}).strict();
export const providerHostSelectorRequestSchema = z.union([
  z.object({ hostRef: hostRefSchema }).strict(),
  z.object({ workDir: z.string().min(1), projectRoot: z.string().min(1) }).strict(),
]);
export const providerHostListResponseSchema = z.object({ hosts: z.array(providerHostInventoryRowSchema) }).strict();
export const providerHostInspectResponseSchema = z.object({ host: providerHostInventoryRowSchema }).strict();
export const providerHostEvictResponseSchema = z
  .object({ ownerId: z.string().min(1), hostRef: hostRefSchema })
  .strict();

export type ProviderHostSelectorRequest = z.input<typeof providerHostSelectorRequestSchema>;
export type ProviderHostListResponse = z.output<typeof providerHostListResponseSchema>;
export type ProviderHostInspectResponse = z.output<typeof providerHostInspectResponseSchema>;
export type ProviderHostEvictResponse = z.output<typeof providerHostEvictResponseSchema>;

/** Catalog declaration for the canonical-coordinator recovery retry operation. */
export const recoveryQuarantineClearRpcSpec = {
  name: 'coordinator.recovery_quarantine.clear',
  kind: 'unary',
  requires: 'system:debug',
  requestSchema: recoveryQuarantineClearRequestSchema,
  responseKind: 'json',
  portKey: 'recoveryQuarantine',
  http: { method: 'POST', path: '/coordinator/recovery-quarantine/clear' },
} as const satisfies RpcMethodSpec<unknown, unknown>;

export const providerHostListRpcSpec = {
  name: 'coordinator.provider_host.list',
  kind: 'unary',
  requires: 'system:debug',
  requestBinding: { kind: 'projectRoot', projectRoot: 'optional-all-projects' },
  requestSchema: providerHostListRequestSchema,
  responseSchema: providerHostListResponseSchema,
  responseKind: 'json',
  portKey: 'providerHosts',
  http: { method: 'GET', path: '/coordinator/provider-hosts' },
} as const satisfies RpcMethodSpec<unknown, unknown>;

export const providerHostInspectRpcSpec = {
  name: 'coordinator.provider_host.inspect',
  kind: 'unary',
  requires: 'system:debug',
  requestBinding: { kind: 'projectRoot', projectRoot: 'optional-all-projects' },
  requestSchema: providerHostSelectorRequestSchema,
  responseSchema: providerHostInspectResponseSchema,
  responseKind: 'json',
  portKey: 'providerHosts',
  http: { method: 'POST', path: '/coordinator/provider-hosts/inspect' },
} as const satisfies RpcMethodSpec<unknown, unknown>;

export const providerHostEvictRpcSpec = {
  name: 'coordinator.provider_host.evict',
  kind: 'unary',
  requires: 'system:shutdown',
  requestBinding: { kind: 'projectRoot', projectRoot: 'optional-all-projects' },
  requestSchema: providerHostSelectorRequestSchema,
  responseSchema: providerHostEvictResponseSchema,
  responseKind: 'json',
  portKey: 'providerHosts',
  http: { method: 'POST', path: '/coordinator/provider-hosts/evict' },
} as const satisfies RpcMethodSpec<unknown, unknown>;

export const transportOperationalCarveouts = [
  '/health',
  '/admin/shutdown',
  '/admin/kb/restart',
  '/events/stream',
] as const;

export const rpcCatalog = [
  {
    name: 'sessions.create',
    kind: 'unary',
    requires: 'jobs:control',
    requestSchema: sessionCreateSchema,
    responseKind: 'json',
    portKey: 'sessions',
    http: { method: 'POST', path: '/sessions' },
  },
  {
    name: 'workflow.run',
    kind: 'unary',
    requires: 'jobs:control',
    requestSchema: workflowRequestSchema,
    responseKind: 'json',
    portKey: 'workflows',
    http: { method: 'POST', path: '/workflow' },
  },
  recoveryQuarantineClearRpcSpec,
  providerHostListRpcSpec,
  providerHostInspectRpcSpec,
  providerHostEvictRpcSpec,
  {
    name: 'coordinator.equipExpansion',
    kind: 'unary',
    requires: 'expansion:manage',
    requestSchema: equipExpansionRequestSchema,
    responseKind: 'json',
    portKey: 'expansion',
    http: { method: 'POST', path: '/coordinator/expansion' },
  },
  {
    name: 'coordinator.unequipExpansion',
    kind: 'unary',
    requires: 'expansion:manage',
    requestSchema: unequipExpansionRequestSchema,
    responseKind: 'json',
    portKey: 'expansion',
    http: { method: 'DELETE', path: '/coordinator/expansion/:name' },
  },
  {
    name: 'coordinator.removeExpansionCatalog',
    kind: 'unary',
    requires: 'expansion:manage',
    requestSchema: removeExpansionCatalogRequestSchema,
    responseKind: 'json',
    portKey: 'expansion',
    http: { method: 'DELETE', path: '/coordinator/expansion/:name/catalog' },
  },
  {
    name: 'coordinator.listExpansion',
    kind: 'unary',
    requires: 'expansion:manage',
    requestSchema: listExpansionRequestSchema,
    responseKind: 'json',
    portKey: 'expansion',
    http: { method: 'GET', path: '/coordinator/expansion' },
  },
  {
    name: 'coordinator.readBinding',
    kind: 'unary',
    requires: 'expansion:manage',
    requestSchema: readBindingRequestSchema,
    responseKind: 'json',
    portKey: 'expansion',
    http: { method: 'GET', path: '/coordinator/bindings/:binding' },
  },
  {
    name: 'jobs.abort',
    kind: 'unary',
    requires: 'jobs:control',
    requestSchema: jobAbortSchema,
    responseKind: 'json',
    portKey: 'jobs',
    http: { method: 'POST', path: '/jobs/abort' },
  },
  {
    name: 'jobs.list',
    kind: 'unary',
    requires: 'jobs:read',
    requestBinding: { kind: 'projectRoot', projectRoot: 'optional-all-projects' },
    requestSchema: jobsListRequestSchema,
    responseKind: 'json',
    portKey: 'jobs',
    http: { method: 'GET', path: '/jobs', queryShape: 'keyed' },
  },
  {
    name: 'jobs.detail',
    kind: 'unary',
    requires: 'jobs:read',
    requestSchema: jobDetailRequestSchema,
    responseKind: 'json',
    portKey: 'jobs',
    http: { method: 'GET', path: '/jobs/:jobId' },
  },
  {
    name: 'jobs.wait',
    kind: 'subscription',
    requires: 'jobs:read',
    requestSchema: jobWaitSchema,
    responseKind: 'notification-stream',
    portKey: 'jobs',
    http: { method: 'POST', path: '/jobs/wait' },
  },
  {
    name: 'discuss.persona.generate',
    kind: 'unary',
    requires: 'discuss:participate',
    requestSchema: discussSeedSchema,
    responseKind: 'json',
    portKey: 'discuss',
    http: { method: 'POST', path: '/discuss/persona-sets' },
  },
  {
    name: 'discuss.session.create',
    kind: 'unary',
    requires: 'discuss:participate',
    requestSchema: discussSessionCreateRequestSchema,
    responseKind: 'json',
    portKey: 'discuss',
    http: { method: 'POST', path: '/discuss/sessions' },
  },
  {
    name: 'discuss.session.list',
    kind: 'unary',
    requires: 'discuss:participate',
    requestSchema: discussSessionListRequestSchema,
    responseKind: 'json',
    portKey: 'discuss',
    http: { method: 'GET', path: '/discuss/sessions' },
  },
  {
    name: 'discuss.session.detail',
    kind: 'unary',
    requires: 'discuss:participate',
    requestSchema: discussSessionDetailRequestSchema,
    responseKind: 'json',
    portKey: 'discuss',
    http: { method: 'GET', path: '/discuss/sessions/:sessionId', queryShape: 'keyed' },
  },
  {
    name: 'discuss.session.events',
    kind: 'unary',
    requires: 'discuss:participate',
    requestSchema: discussSessionEventsRequestSchema,
    responseKind: 'json',
    portKey: 'discuss',
    http: { method: 'GET', path: '/discuss/sessions/:sessionId/events', queryShape: 'keyed' },
  },
  {
    name: 'discuss.session.bid',
    kind: 'unary',
    requires: 'discuss:participate',
    requestSchema: discussSessionBidRequestSchema,
    responseKind: 'json',
    portKey: 'discuss',
    http: { method: 'POST', path: '/discuss/sessions/:sessionId/bids' },
  },
  {
    name: 'discuss.session.speech',
    kind: 'unary',
    requires: 'discuss:participate',
    requestSchema: discussSessionSpeechRequestSchema,
    responseKind: 'json',
    portKey: 'discuss',
    http: { method: 'POST', path: '/discuss/sessions/:sessionId/speeches' },
  },
  {
    name: 'discuss.session.delete',
    kind: 'unary',
    requires: 'discuss:participate',
    requestSchema: discussSessionDeleteRequestSchema,
    responseKind: 'json',
    portKey: 'discuss',
    http: { method: 'DELETE', path: '/discuss/sessions/:sessionId', queryShape: 'keyed' },
  },
  {
    name: 'kb.entries.search',
    kind: 'unary',
    requires: 'kb:read',
    requestSchema: kbEntriesRequestSchema,
    responseKind: 'json',
    portKey: 'kb',
    http: { method: 'GET', path: '/kb/entries', queryShape: 'keyed' },
  },
  {
    name: 'kb.diagnose',
    kind: 'unary',
    requires: 'kb:read',
    requestSchema: kbDiagnoseRequestSchema,
    responseKind: 'json',
    portKey: 'kb',
    http: { method: 'GET', path: '/kb/diagnose' },
  },
  {
    name: 'kb.note.read',
    kind: 'unary',
    requires: 'kb:read',
    requestSchema: kbNoteReadRequestSchema,
    responseKind: 'json',
    portKey: 'kb',
    http: { method: 'GET', path: '/kb/notes/:slug' },
  },
  {
    name: 'kb.note.create',
    kind: 'unary',
    requires: 'kb:write',
    requestSchema: kbNoteCreateRequestSchema,
    responseKind: 'json',
    portKey: 'kb',
    http: { method: 'POST', path: '/kb/notes' },
  },
  {
    name: 'kb.note.update',
    kind: 'unary',
    requires: 'kb:write',
    requestSchema: kbNoteUpdateRequestSchema,
    responseKind: 'json',
    portKey: 'kb',
    http: { method: 'PUT', path: '/kb/notes/:slug' },
  },
  {
    name: 'kb.note.delete',
    kind: 'unary',
    requires: 'kb:write',
    requestSchema: kbNoteDeleteRequestSchema,
    responseKind: 'json',
    portKey: 'kb',
    http: { method: 'DELETE', path: '/kb/notes/:slug' },
  },
  {
    name: 'kb.source.list',
    kind: 'unary',
    requires: 'kb:read',
    requestSchema: kbSourceListRequestSchema,
    responseKind: 'json',
    portKey: 'kb',
    http: { method: 'GET', path: '/kb/sources' },
  },
  {
    name: 'kb.source.read',
    kind: 'unary',
    requires: 'kb:read',
    requestSchema: kbSourceReadRequestSchema,
    responseKind: 'json',
    portKey: 'kb',
    http: { method: 'GET', path: '/kb/sources/:slug' },
  },
  {
    name: 'kb.source.create',
    kind: 'unary',
    requires: 'kb:source:import',
    requestSchema: kbSourceCreateRequestSchema,
    responseKind: 'json',
    portKey: 'kb',
    http: { method: 'POST', path: '/kb/sources' },
  },
  {
    name: 'kb.source.delete',
    kind: 'unary',
    requires: 'kb:write',
    requestSchema: kbSourceDeleteRequestSchema,
    responseKind: 'json',
    portKey: 'kb',
    http: { method: 'DELETE', path: '/kb/sources/:slug' },
  },
  {
    name: 'kb.wiki.list',
    kind: 'unary',
    requires: 'kb:read',
    requestSchema: kbWikiListRequestSchema,
    responseKind: 'json',
    portKey: 'kb',
    http: { method: 'GET', path: '/kb/wikis' },
  },
  {
    name: 'kb.wiki.read',
    kind: 'unary',
    requires: 'kb:read',
    requestSchema: kbWikiReadRequestSchema,
    responseKind: 'json',
    portKey: 'kb',
    http: { method: 'GET', path: '/kb/wikis/:slug' },
  },
  {
    name: 'kb.wiki.create',
    kind: 'unary',
    requires: 'kb:write',
    requestSchema: kbWikiCreateRequestSchema,
    responseKind: 'json',
    portKey: 'kb',
    http: { method: 'POST', path: '/kb/wikis' },
  },
  {
    name: 'kb.wiki.rewrite',
    kind: 'unary',
    requires: 'kb:write',
    requestSchema: kbWikiRewriteRequestSchema,
    responseKind: 'json',
    portKey: 'kb',
    http: { method: 'POST', path: '/kb/wikis/:slug/understanding' },
  },
  {
    name: 'kb.wiki.link',
    kind: 'unary',
    requires: 'kb:write',
    requestSchema: kbWikiLinkRequestSchema,
    responseKind: 'json',
    portKey: 'kb',
    http: { method: 'POST', path: '/kb/wikis/:slug/knowledge' },
  },
  {
    name: 'kb.wiki.unlink',
    kind: 'unary',
    requires: 'kb:write',
    requestSchema: kbWikiUnlinkRequestSchema,
    responseKind: 'json',
    portKey: 'kb',
    http: { method: 'POST', path: '/kb/wikis/:slug/knowledge/unlink' },
  },
  {
    name: 'kb.wiki.cite',
    kind: 'unary',
    requires: 'kb:write',
    requestSchema: kbWikiCiteRequestSchema,
    responseKind: 'json',
    portKey: 'kb',
    http: { method: 'POST', path: '/kb/wikis/:slug/knowledge/cite' },
  },
  {
    name: 'kb.wiki.adopt',
    kind: 'unary',
    requires: 'kb:write',
    requestSchema: kbWikiAdoptRequestSchema,
    responseKind: 'json',
    portKey: 'kb',
    http: { method: 'POST', path: '/kb/wikis/:slug/knowledge/adopt' },
  },
  {
    name: 'kb.wiki.delete',
    kind: 'unary',
    requires: 'kb:write',
    requestSchema: kbWikiDeleteRequestSchema,
    responseKind: 'json',
    portKey: 'kb',
    http: { method: 'DELETE', path: '/kb/wikis/:slug' },
  },
  {
    name: 'kb.wake_up',
    kind: 'unary',
    requires: 'kb:read',
    requestSchema: kbWakeUpRequestSchema,
    responseKind: 'json',
    portKey: 'kb',
    http: { method: 'GET', path: '/kb/wake-up' },
  },
  {
    name: 'kb.community.read',
    kind: 'unary',
    requires: 'kb:read',
    requestSchema: kbCommunityReadRequestSchema,
    responseKind: 'json',
    portKey: 'kb',
    http: { method: 'GET', path: '/kb/communities/:slug' },
  },
  {
    name: 'kb.community.list-stale',
    kind: 'unary',
    requires: 'kb:read',
    requestSchema: kbCommunityListStaleRequestSchema,
    responseKind: 'json',
    portKey: 'kb',
    http: { method: 'GET', path: '/kb/communities-stale' },
  },
  {
    name: 'kb.community.summary-input',
    kind: 'unary',
    requires: 'kb:read',
    requestSchema: kbCommunitySummaryInputRequestSchema,
    responseKind: 'json',
    portKey: 'kb',
    http: { method: 'GET', path: '/kb/communities/:slug/summary-input' },
  },
  {
    name: 'kb.community.set-summary',
    kind: 'unary',
    requires: 'kb:write',
    requestSchema: kbCommunitySetSummaryRequestSchema,
    responseKind: 'json',
    portKey: 'kb',
    http: { method: 'POST', path: '/kb/communities/:slug/summary' },
  },
  {
    name: 'kb.memo.list',
    kind: 'unary',
    requires: 'kb:read',
    requestSchema: kbMemoListQuerySchema,
    responseKind: 'json',
    portKey: 'kb',
    http: { method: 'GET', path: '/kb/memos', queryShape: 'keyed' },
  },
  {
    name: 'kb.memo.read',
    kind: 'unary',
    requires: 'kb:read',
    requestSchema: kbMemoReadRequestSchema,
    responseKind: 'json',
    portKey: 'kb',
    http: { method: 'GET', path: '/kb/memos/:slug', queryShape: 'keyed' },
  },
  {
    name: 'kb.memo.create',
    kind: 'unary',
    requires: 'kb:write',
    requestSchema: kbMemoCreateRequestSchema,
    responseKind: 'json',
    portKey: 'kb',
    http: { method: 'POST', path: '/kb/memos' },
  },
  {
    name: 'kb.memo.delete',
    kind: 'unary',
    requires: 'kb:write',
    requestSchema: kbMemoDeleteRequestSchema,
    responseKind: 'json',
    portKey: 'kb',
    http: { method: 'DELETE', path: '/kb/memos', queryShape: 'keyed' },
  },
  {
    name: 'kb.principles.list',
    kind: 'unary',
    requires: 'kb:read',
    requestSchema: kbPrinciplesListRequestSchema,
    responseKind: 'json',
    portKey: 'kb',
    http: { method: 'GET', path: '/kb/principles', queryShape: 'keyed' },
  },
  {
    name: 'kb.principle.read',
    kind: 'unary',
    requires: 'kb:read',
    requestSchema: kbPrincipleReadRequestSchema,
    responseKind: 'json',
    portKey: 'kb',
    http: { method: 'GET', path: '/kb/principles/:slug' },
  },
  {
    name: 'kb.reindex',
    kind: 'unary',
    requires: 'kb:write',
    requestSchema: kbReindexRequestSchema,
    responseKind: 'json',
    portKey: 'kb',
    http: { method: 'POST', path: '/kb/index' },
  },
] as const satisfies readonly RpcMethodSpec<unknown, unknown>[];
