import type { Command } from 'commander';

import { resolvePluginRoot } from './plugin-root.js';

import type { InvocationContext } from '../runtime/invocation-context.js';
import type { DiscussAbortResponse, DiscussStartResponse } from '../discuss/read-contract.js';
import type { BidResult, PersonaSeedOutput, SpeechResult } from '../discuss/session-types.js';
import type { WatchState } from '../discuss/watch.js';
import type { AcceptedLaunchResponse } from '../jobs/launch.js';
import type { JobStatus, JobsListResponse } from '../jobs/records.js';
import type { RetentionPolicy } from '../sessions/entry.js';
import type {
  KbDiagnoseInput,
  KbDiagnoseResult,
  KbDeleteInput,
  KbDeleteResponse,
  KbMemoDeleteInput,
  KbMemoDeleteResult,
  KbMemoInput,
  KbMemoListInput,
  KbMemoListResult,
  KbMemoPurgeInput,
  KbMemoPurgeResult,
  KbMemoResponse,
  KbPrinciplesInput,
  KbPrinciplesResult,
  KbPromoteInput,
  KbPromoteResponse,
  KbReadInput,
  KbReadResult,
  KbReindexInput,
  KbReindexResponse,
  KbSearchInput,
  KbSearchResponse,
  KbSourceDeleteInput,
  KbSourceDeleteResponse,
  KbSourceImportResponse,
  KbSourceListResult,
  KbSourcePersistInput,
  KbUpdateInput,
  KbUpdateResponse,
  KbWakeUpInput,
  KbWakeUpResponse,
  KbWikiAdoptInput,
  KbWikiAdoptResponse,
  KbWikiCiteInput,
  KbWikiCreateInput,
  KbWikiCreateResponse,
  KbWikiDeleteInput,
  KbWikiDeleteResponse,
  KbWikiLinkInput,
  KbWikiListResult,
  KbWikiMutationResponse,
  KbWikiReadInput,
  KbWikiRewriteInput,
  KbWikiUnlinkInput,
} from '../kb/entry-types.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { getSharedReadCoralStore } from './read-store.js';
import { CONTEXT_ENV_KEY, TRANSPORT_CONTEXT_FIELDS } from '../transport/context-profile.js';
import type { AbortResult } from '../jobs/contracts/abort-registry.js';
import { HEALTH_TIMEOUT_MS, TOOL_TIMEOUT_MS } from '../transport/http/sse.js';
import type { IpcSubscription, IpcSubscriptionOptions } from '../transport/ipc/client.js';
import { ensure } from '../transport/ipc/ensure.js';
import { classifyCommand, commandPath } from './classify.js';

type SessionRequestOptions = {
  provider?: string;
  model?: string;
  workDir?: string;
  owner?: string;
  effort?: string;
  claudeModelCap?: string;
  bypassPermissions?: boolean;
  systemPrompt?: string;
};

type CreateSessionRequestOptions = SessionRequestOptions & {
  agent?: string;
  retention?: RetentionPolicy;
};

type WorkflowRequestOptions = {
  startPrompt: string;
  context?: string;
  provider?: string;
  workDir?: string;
  owner?: string;
  claudeModelCap?: string;
};

type JobsListOptions = {
  projectRoot?: string;
  phase?: JobStatus['phase'];
  all?: boolean;
  provider?: string;
};

type DiscussSeedArgs = {
  controversy_axes: Array<{ axis: string; positions: string[] }>;
  n: number;
  seed: number;
  demographics?: { origin_weights: Record<string, number>; outlier_ratio?: number };
};

export type AbortCapableClient = {
  abortJobs(jobIds: string[]): Promise<AbortResult>;
};

export type CliCommandClient = AbortCapableClient & {
  createSession(
    provider: string,
    prompt: string,
    options?: CreateSessionRequestOptions,
  ): Promise<AcceptedLaunchResponse>;
  workflow(expression: string, options: WorkflowRequestOptions): Promise<AcceptedLaunchResponse>;
  listJobs(options?: JobsListOptions): Promise<JobsListResponse>;
  discussSeed(args: DiscussSeedArgs): Promise<PersonaSeedOutput>;
  discussStart(args: {
    agents: Array<{ name: string; persona: string }>;
    topic?: string;
    config?: { min_bid_delay_ms?: number };
  }): Promise<DiscussStartResponse>;
  discussWatch(session: string, cursor?: number): Promise<WatchState>;
  discussBid(args: { session: string; agent_name: string; score: number; thought: string }): Promise<BidResult>;
  discussSpeech(args: { session: string; agent_name: string; content: string }): Promise<SpeechResult>;
  discussAbort(session: string): Promise<DiscussAbortResponse>;
  kbSearch(args: KbSearchInput): Promise<KbSearchResponse>;
  kbDiagnose(args?: KbDiagnoseInput): Promise<KbDiagnoseResult>;
  kbPrinciples(args: KbPrinciplesInput): Promise<KbPrinciplesResult>;
  kbRead(args: KbReadInput): Promise<KbReadResult>;
  kbPromote(args: KbPromoteInput): Promise<KbPromoteResponse>;
  kbUpdate(args: KbUpdateInput): Promise<KbUpdateResponse>;
  kbDelete(args: KbDeleteInput): Promise<KbDeleteResponse>;
  kbWikiCreate(args: KbWikiCreateInput): Promise<KbWikiCreateResponse>;
  kbWikiRewrite(args: KbWikiRewriteInput): Promise<KbWikiMutationResponse>;
  kbWikiLink(args: KbWikiLinkInput): Promise<KbWikiMutationResponse>;
  kbWikiUnlink(args: KbWikiUnlinkInput): Promise<KbWikiMutationResponse>;
  kbWikiCite(args: KbWikiCiteInput): Promise<KbWikiMutationResponse>;
  kbWikiAdopt(args: KbWikiAdoptInput): Promise<KbWikiAdoptResponse>;
  kbWikiDelete(args: KbWikiDeleteInput): Promise<KbWikiDeleteResponse>;
  kbWikiList(): Promise<KbWikiListResult>;
  kbWikiRead(args: KbWikiReadInput): Promise<KbReadResult>;
  kbWakeUp(args?: KbWakeUpInput): Promise<KbWakeUpResponse>;
  kbSourceImport(args: KbSourcePersistInput): Promise<KbSourceImportResponse>;
  kbSourceList(): Promise<KbSourceListResult>;
  kbSourceDelete(args: KbSourceDeleteInput): Promise<KbSourceDeleteResponse>;
  kbMemo(args: KbMemoInput): Promise<KbMemoResponse>;
  kbMemoList(args: KbMemoListInput): Promise<KbMemoListResult>;
  kbMemoDelete(args: KbMemoDeleteInput): Promise<KbMemoDeleteResult>;
  kbMemoPurge(args: KbMemoPurgeInput): Promise<KbMemoPurgeResult>;
  kbReindex(args?: KbReindexInput): Promise<KbReindexResponse>;
  subscribe<TResult>(
    method: string,
    params?: unknown,
    options?: IpcSubscriptionOptions,
  ): Promise<IpcSubscription<TResult>>;
};

export type ProviderRunOptions = {
  input?: string[];
  workDir?: string;
  model?: string;
  owner?: string;
  bypassPermissions?: boolean;
  detach?: boolean;
};

export type WaitOptions = {
  jobs: string;
  cursor?: string;
  embed?: boolean;
};

export type AbortOptions = {
  jobs?: string;
  all?: boolean;
  phase?: string;
  provider?: string;
};

export type WorkflowOptions = {
  expression?: string;
  startPrompt?: string[];
  context?: string[];
  provider?: string;
  workDir?: string;
  detach?: boolean;
  owner?: string;
};

export type DiscussSeedOptions = {
  inputJson?: string;
  axis?: string[];
  count?: string;
  seed?: string;
};

export type DiscussStartOptions = {
  inputJson?: string;
  agent?: string[];
  topic?: string;
};

export type DiscussWatchOptions = {
  session: string;
  cursor?: string;
};

export type DiscussParticipateOptions = {
  inputJson?: string;
  session?: string;
  agentName?: string;
  score?: string;
  thought?: string;
  content?: string;
};

export type DiscussAbortOptions = {
  session: string;
};

export type KbSearchOptions = {
  topK?: string;
  scope?: 'notes' | 'communities' | 'sources' | 'wiki' | 'all';
  vector?: boolean;
  hybrid?: boolean;
};

export type KbPrinciplesOptions = {
  query?: string;
  topK?: string;
  verbose?: boolean;
};

export type KbPromoteOptions = {
  memo?: string;
  title?: string;
  contentFile?: string;
  domain?: string;
  topic?: string;
};

export type KbUpdateOptions = {
  title?: string;
  contentFile?: string;
};

export type KbSourceImportOptions = {
  slug?: string;
  ready?: 'commit' | 'base-search' | 'active-vector' | 'all-equipped';
  async?: boolean;
};

export type KbWikiCreateOptions = {
  title?: string;
  tag?: string[];
};

export type KbWikiRewriteOptions = {
  from: string;
};

export type KbWikiCiteOptions = {
  from: string;
};

export type KbWikiAdoptOptions = {
  memo: string;
  title: string;
  contentFile: string;
  domain: string;
  topic: string;
};

export type KbReindexOptions = {
  async?: boolean;
};

export type KbMemoWriteOptions = {
  topic: string;
  content?: string;
  contentFile?: string;
  owner?: string;
};

export type KbMemoListOptions = {
  owner?: string;
};

export type KbMemoDeleteOptions = {
  owner?: string;
};

export type KbMemoPurgeOptions = {
  owner?: string;
};

// Wait emits a `waiting` event at this deadline so the process exits before
// the cli-resolve hook's Bash timeout (600_000ms) kills it — leaving room
// for the final event (and its resume cursor) to reach stdout.
export const WAIT_TIMEOUT_SECONDS = 590;

// no module-level capture: callers go through resolvePluginRoot() at use time

export function getProviderNames(providerRegistry: ProviderRegistry): string[] {
  return providerRegistry.getAll().map((provider) => provider.name);
}

function collectCoralEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of Object.keys(process.env)) {
    const value = process.env[key];
    if (!key.startsWith('CORAL_') || value === undefined) {
      continue;
    }
    env[key] = value;
  }
  return env;
}

function createDefaultInvocationContext(projectRoot: string): InvocationContext {
  return {
    pluginRoot: resolvePluginRoot() ?? '',
    projectRoot,
    coralEnv: collectCoralEnv(),
    authority: 'admin',
  };
}

function buildTransportContextBody(args: Record<string, unknown>, context: InvocationContext): Record<string, unknown> {
  const body: Record<string, unknown> = {
    ...args,
    projectRoot: context.projectRoot,
  };

  for (const field of TRANSPORT_CONTEXT_FIELDS) {
    if (body[field] !== undefined) {
      continue;
    }

    const value = context.coralEnv[CONTEXT_ENV_KEY[field]];
    if (typeof value === 'string' && value.length > 0) {
      body[field] = value;
    }
  }

  return body;
}

function buildKbMutationTransportContextBody(
  args: Record<string, unknown>,
  context: InvocationContext,
): Record<string, unknown> {
  const body = buildTransportContextBody(args, context);
  const jobId = context.coralEnv.CORAL_JOB_ID;
  const sessionId = context.coralEnv.CORAL_SESSION_ID;

  if (body.jobId === undefined && typeof jobId === 'string' && jobId.length > 0) {
    body.jobId = jobId;
  }
  if (body.sessionId === undefined && typeof sessionId === 'string' && sessionId.length > 0) {
    body.sessionId = sessionId;
  }

  return body;
}

function buildProjectScopedQuery(args: Record<string, unknown>, context: InvocationContext): Record<string, unknown> {
  return {
    ...args,
    projectRoot: context.projectRoot,
  };
}

function resolveMemoOwner(owner: string | undefined, context: InvocationContext): string | undefined {
  if (owner !== undefined) {
    return owner;
  }

  const fallback = context.coralEnv.CORAL_OWNER;
  return typeof fallback === 'string' && fallback.length > 0 ? fallback : undefined;
}

export function makeClient(projectRoot: string, command: Command): CliCommandClient {
  const path = commandPath(command);
  const resolution = classifyCommand(command);

  if (resolution.kind === 'container') {
    throw new Error(`makeClient() cannot dispatch a container command: ${path}`);
  }

  if (resolution.kind === 'exempt') {
    throw new Error(`makeClient() cannot dispatch exempt command "${path}": ${resolution.rationale}`);
  }

  if (resolution.kind === 'unclassified') {
    throw new Error(`makeClient() cannot dispatch unclassified command "${path}"`);
  }

  const commandClass = resolution.commandClass;
  const defaultContext = createDefaultInvocationContext(projectRoot);

  const request = async <TResult>(method: string, params?: unknown): Promise<TResult> => {
    const client = await ensure(resolvePluginRoot());
    return client.request<TResult>(method, params, { timeoutMs: TOOL_TIMEOUT_MS });
  };

  const subscribe = async <TResult>(
    method: string,
    params?: unknown,
    options?: IpcSubscriptionOptions,
  ): Promise<IpcSubscription<TResult>> => {
    if (commandClass !== 'subscribe') {
      throw new Error(`Command "${path}" is classified as ${commandClass} and cannot open subscriptions.`);
    }

    const client = await ensure(resolvePluginRoot());
    return client.subscribe<TResult>(method, params, {
      timeoutMs: HEALTH_TIMEOUT_MS,
      ...options,
    });
  };

  const readStore = () => getSharedReadCoralStore(projectRoot);

  return {
    createSession: async (provider, prompt, options = {}) => {
      return request<AcceptedLaunchResponse>(
        'sessions.create',
        buildTransportContextBody({ provider, prompt, ...options }, defaultContext),
      );
    },
    workflow: async (expression, options) => {
      return request<AcceptedLaunchResponse>(
        'workflow.run',
        buildTransportContextBody({ expression, ...options }, defaultContext),
      );
    },
    listJobs: async (options = {}) => {
      const filters = {
        projectRoot: options.projectRoot ?? projectRoot,
        ...(options.phase !== undefined ? { phase: options.phase } : {}),
        ...(options.provider !== undefined ? { provider: options.provider } : {}),
        ...(options.all === true ? { all: true } : {}),
      };
      if (commandClass === 'read') {
        return { jobs: readStore().jobs.list(filters) };
      }
      return request<JobsListResponse>('jobs.list', filters);
    },
    abortJobs: async (jobIds) =>
      request<AbortResult>('jobs.abort', buildProjectScopedQuery({ jobs: jobIds }, defaultContext)),
    discussSeed: async (args) => request<PersonaSeedOutput>('discuss.persona.generate', args),
    discussStart: async (args) =>
      request<DiscussStartResponse>('discuss.session.create', buildTransportContextBody(args, defaultContext)),
    discussWatch: async (session, cursor) => {
      if (commandClass === 'read') {
        return readStore().discuss.watch(session, cursor);
      }

      return request<WatchState>(
        'discuss.session.events',
        buildProjectScopedQuery(
          {
            sessionId: session,
            ...(cursor === undefined ? {} : { cursor }),
          },
          defaultContext,
        ),
      );
    },
    discussBid: async (args) =>
      request<BidResult>(
        'discuss.session.bid',
        buildTransportContextBody({ ...args, sessionId: args.session }, defaultContext),
      ),
    discussSpeech: async (args) =>
      request<SpeechResult>(
        'discuss.session.speech',
        buildTransportContextBody({ ...args, sessionId: args.session }, defaultContext),
      ),
    discussAbort: async (session) =>
      request<DiscussAbortResponse>(
        'discuss.session.delete',
        buildProjectScopedQuery({ sessionId: session }, defaultContext),
      ),
    kbSearch: async (args) => {
      if (commandClass === 'read') {
        return readStore().kb.search(args);
      }

      return request<KbSearchResponse>('kb.entries.search', {
        q: args.query,
        ...(args.scope === undefined ? {} : { scope: args.scope }),
        ...(args.top_k === undefined ? {} : { top_k: args.top_k }),
        ...(args.mode === undefined ? {} : { mode: args.mode }),
      });
    },
    kbDiagnose: async (_args = {}) => {
      if (commandClass === 'read') {
        return readStore().kb.diagnose();
      }

      return request<KbDiagnoseResult>('kb.diagnose', {});
    },
    kbPrinciples: async (args) => {
      if (commandClass === 'read') {
        return readStore().kb.listPrinciples(args);
      }

      return request<KbPrinciplesResult>('kb.principles.list', {
        ...(args.query === undefined ? {} : { q: args.query }),
        ...(args.top_k === undefined ? {} : { top_k: args.top_k }),
        ...(args.verbose === undefined ? {} : { verbose: args.verbose }),
      });
    },
    kbRead: async (args) => {
      if (commandClass === 'read') {
        return readStore().kb.read(args);
      }

      throw new Error(`Command "${path}" is classified as ${commandClass} and cannot issue direct KB reads.`);
    },
    kbPromote: async (args) =>
      request<KbPromoteResponse>('kb.note.create', buildKbMutationTransportContextBody(args, defaultContext)),
    kbUpdate: async ({ note, ...rest }) =>
      request<KbUpdateResponse>(
        'kb.note.update',
        buildKbMutationTransportContextBody({ ...rest, slug: note }, defaultContext),
      ),
    kbDelete: async (args) =>
      request<KbDeleteResponse>(
        'kb.note.delete',
        buildKbMutationTransportContextBody({ slug: args.note }, defaultContext),
      ),
    kbWikiCreate: async (args) =>
      request<KbWikiCreateResponse>('kb.wiki.create', buildKbMutationTransportContextBody(args, defaultContext)),
    kbWikiRewrite: async (args) =>
      request<KbWikiMutationResponse>('kb.wiki.rewrite', buildKbMutationTransportContextBody(args, defaultContext)),
    kbWikiLink: async (args) =>
      request<KbWikiMutationResponse>('kb.wiki.link', buildKbMutationTransportContextBody(args, defaultContext)),
    kbWikiUnlink: async (args) =>
      request<KbWikiMutationResponse>('kb.wiki.unlink', buildKbMutationTransportContextBody(args, defaultContext)),
    kbWikiCite: async (args) =>
      request<KbWikiMutationResponse>('kb.wiki.cite', buildKbMutationTransportContextBody(args, defaultContext)),
    kbWikiAdopt: async (args) =>
      request<KbWikiAdoptResponse>('kb.wiki.adopt', buildKbMutationTransportContextBody(args, defaultContext)),
    kbWikiDelete: async (args) =>
      request<KbWikiDeleteResponse>(
        'kb.wiki.delete',
        buildKbMutationTransportContextBody({ slug: args.slug }, defaultContext),
      ),
    kbWikiList: async () => {
      if (commandClass === 'read') {
        return readStore().kb.listWikis();
      }

      return request<KbWikiListResult>('kb.wiki.list', {});
    },
    kbWikiRead: async (args) => request<KbReadResult>('kb.wiki.read', { slug: args.slug }),
    kbWakeUp: async (args = {}) => {
      if (commandClass === 'read') {
        return readStore().kb.wakeUp(args);
      }

      return request<KbWakeUpResponse>('kb.wake_up', args);
    },
    kbSourceImport: async (args) =>
      request<KbSourceImportResponse>('kb.source.create', buildKbMutationTransportContextBody(args, defaultContext)),
    kbSourceList: async () => {
      if (commandClass === 'read') {
        return readStore().kb.listSources();
      }

      return request<KbSourceListResult>('kb.source.list', {});
    },
    kbSourceDelete: async (args) =>
      request<KbSourceDeleteResponse>(
        'kb.source.delete',
        buildKbMutationTransportContextBody({ slug: args.slug }, defaultContext),
      ),
    kbMemo: async (args) =>
      request<KbMemoResponse>('kb.memo.create', buildKbMutationTransportContextBody(args, defaultContext)),
    kbMemoList: async (args) => {
      const owner = resolveMemoOwner(args.owner, defaultContext);

      if (commandClass === 'read') {
        return readStore().kb.listMemos(owner === undefined ? {} : { owner });
      }

      return request<KbMemoListResult>(
        'kb.memo.list',
        buildProjectScopedQuery(owner === undefined ? {} : { owner }, defaultContext),
      );
    },
    kbMemoDelete: async (args) => {
      const owner = resolveMemoOwner(args.owner, defaultContext);
      return request<KbMemoDeleteResult>(
        'kb.memo.delete',
        buildKbMutationTransportContextBody(
          {
            pattern: args.pattern,
            ...(owner === undefined ? {} : { owner }),
          },
          defaultContext,
        ),
      );
    },
    kbMemoPurge: async (args) => {
      const owner = resolveMemoOwner(args.owner, defaultContext);
      return request<KbMemoPurgeResult>(
        'kb.memo.delete',
        buildKbMutationTransportContextBody(
          {
            all: true,
            ...(owner === undefined ? {} : { owner }),
          },
          defaultContext,
        ),
      );
    },
    kbReindex: async (args = {}) =>
      request<KbReindexResponse>('kb.reindex', buildKbMutationTransportContextBody(args, defaultContext)),
    subscribe,
  };
}

export function getPluginRoot(): string {
  return resolvePluginRoot() ?? '';
}
