import type { Command } from 'commander';
import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';

import { resolvePluginRoot } from './plugin-root.js';

import type { InvocationContext } from '../runtime/invocation-context.js';
import { resolveUserHomeDir } from '../infra/path/index.js';
import type { DiscussAbortResponse, DiscussStartResponse } from '../discuss/read-contract.js';
import type { BidResult, PersonaSeedOutput, SpeechResult } from '../discuss/session-types.js';
import type { WatchState } from '../discuss/watch.js';
import type { AcceptedLaunchResponse } from '../jobs/launch.js';
import type { JobDetailResponse, JobStatus, JobsListResponse } from '../jobs/records.js';
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
import { createBuiltInProviderRegistry } from '../providers/bootstrap.js';
import { providerBindingFailureCode } from '../providers/contracts/binding.js';
import { discussProviderNames } from '../discuss/execution-policy.js';
import { getSharedReadCoralStore } from './read-store.js';
import { CONTEXT_ENV_KEY, TRANSPORT_CONTEXT_FIELDS } from '../transport/context-profile.js';
import type { AbortResult } from '../jobs/contracts/abort-registry.js';
import { HEALTH_TIMEOUT_MS, TOOL_TIMEOUT_MS } from '../transport/http/sse.js';
import type { IpcSubscription, IpcSubscriptionOptions } from '../transport/ipc/client.js';
import { ensure, type RawCoordinatorHealth } from '../transport/ipc/ensure.js';
import { childPrincipalAuthFromEnv, childPrincipalAuthOptions } from '../transport/ipc/child-principal-auth.js';
import { CORAL_KB_ENABLE_ENV, KB_DISABLED_REASON, resolveKbEnabled } from '../infra/kb-toggle.js';
import { filterForwardableCoralEnv } from '../infra/env-sanitize.js';
import { collectForwardedNetworkEnv } from '../infra/network-env.js';
import type { Principal } from '../security/principal.js';
import { classifyCommand, commandPath } from './classify.js';
import { ProviderSelectionError } from './errors.js';
import { parseExpression } from '../workflow/parser.js';
import { normalizeAst, workflowProviderNames } from '../workflow/normalize.js';

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
  /**
   * List across every project instead of scoping to the caller's cwd. When set,
   * no `projectRoot` filter is sent, so the backend returns all projects' jobs
   * (KB jobs included). Used by `coral jobs`; the abort selector leaves it unset
   * to keep bulk aborts project-scoped.
   */
  allProjects?: boolean;
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
  detailJob(jobId: string): Promise<JobDetailResponse>;
  discussSeed(args: DiscussSeedArgs): Promise<PersonaSeedOutput>;
  discussStart(args: {
    agents: Array<{
      name: string;
      persona: string;
      participation?: 'required' | 'observer';
      provider?: string;
      model?: string;
    }>;
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
  kbCommunityListStale(): Promise<Array<{ slug: string; level: number }>>;
  kbCommunitySummaryInput(args: {
    slug: string;
  }): Promise<{ slug: string; level: number; kind: 'leaf' | 'parent'; input: string }>;
  kbCommunitySetSummary(args: { slug: string; summary: string }): Promise<{ slug: string }>;
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
  memo: string;
  title: string;
  contentFile: string;
  domain: string;
  topic: string;
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
  const principal: Principal = {
    subject: 'operator',
    transport: 'cli',
    credential: { kind: 'placeholder', id: 'cli-default' },
    binding: { kind: 'project', root: projectRoot },
  };

  return {
    pluginRoot: resolvePluginRoot() ?? '',
    projectRoot,
    coralEnv: collectCoralEnv(),
    principal,
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

  // Forward the caller shell's proxy/CA env to spawned providers. The daemon's
  // own env is frozen at boot, so these must travel per-request to reach the
  // claude/codex broker children.
  const networkEnv = collectForwardedNetworkEnv(process.env);
  if (Object.keys(networkEnv).length > 0) {
    body.networkEnv = networkEnv;
  }

  // Forward the caller's fresh CORAL_* config (model, effort, worker caps, …)
  // for the same reason: the daemon's CORAL_* is frozen at boot, so a change to
  // the caller's settings only reaches spawned providers if it travels
  // per-request. Daemon-owned identity/boot keys are filtered out here and
  // re-asserted daemon-side. The field is attached unconditionally — even when
  // empty — so the daemon can tell "caller cleared all config, use defaults"
  // (present, empty) apart from "caller doesn't forward" (absent); without this
  // the daemon would keep serving its stale boot value after the caller unset
  // their last CORAL_* var.
  body.coralEnv = filterForwardableCoralEnv(context.coralEnv);

  return body;
}

async function buildProviderTransportContextBody(
  args: Record<string, unknown>,
  context: InvocationContext,
  registry: ProviderRegistry,
  providerNames: readonly string[],
): Promise<Record<string, unknown>> {
  const body = buildTransportContextBody(args, context);
  const captured = await registry.captureScope(
    { origin: 'caller' },
    providerNames,
    {
      env: { ...process.env },
      homeDir: resolveUserHomeDir(process.env.HOME ?? process.env.USERPROFILE),
    },
    { readFileSync, readdirSync, realpathSync, statSync },
  );
  if (!captured.ok) {
    throw new ProviderSelectionError(
      providerBindingFailureCode(captured.failure),
      registry.renderBindingFailure(captured.failure),
      'Remove unsupported credential overrides, select an absolute authenticated provider profile, and retry.',
    );
  }
  body.providerScope = captured.value;
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
  const providerRegistry = createBuiltInProviderRegistry();
  const ipcAuth = childPrincipalAuthFromEnv();
  const ipcAuthOptions = () => childPrincipalAuthOptions(ipcAuth);

  // A KB command probes once so a KB-disabled incumbent follows the same live
  // authority rule as every other invocation. A later idle restart may inherit
  // this process's KB setting without interrupting current coordinator work.
  let kbReconcileDone = false;
  const reconcileKbBoot = async (): Promise<void> => {
    if (kbReconcileDone || !path.startsWith('kb ')) return;
    kbReconcileDone = true;
    if (ipcAuth !== undefined) return;
    if (!resolveKbEnabled(process.env[CORAL_KB_ENABLE_ENV])) return;
    try {
      const client = await ensure(getPluginRoot());
      const health = await client.health<RawCoordinatorHealth>({ timeoutMs: HEALTH_TIMEOUT_MS });
      const kbDisabled = (health.components ?? []).some(
        (s) => s.id === 'kb' && s.phase === 'offline' && s.reason === KB_DISABLED_REASON,
      );
      if (kbDisabled) {
        process.stderr.write(
          'KB is disabled on the running Coral coordinator, so this command will fail; continuing without a ' +
            'restart so in-flight work is not interrupted. KB turns on at the next idle restart ' +
            "(CORAL_BACKEND_IDLE_MS, default ~6h) — run 'coral-cli backend shutdown' to force it now if " +
            'nothing else is running.\n',
        );
        return;
      }
    } catch {
      // Best-effort: fall through and let the command run against the daemon.
    }
  };

  const request = async <TResult>(method: string, params?: unknown): Promise<TResult> => {
    const authOptions = ipcAuthOptions();
    await reconcileKbBoot();
    const client = await ensure(resolvePluginRoot());
    return client.request<TResult>(method, params, {
      timeoutMs: TOOL_TIMEOUT_MS,
      ...authOptions,
    });
  };

  const subscribe = async <TResult>(
    method: string,
    params?: unknown,
    options?: IpcSubscriptionOptions,
  ): Promise<IpcSubscription<TResult>> => {
    if (commandClass !== 'subscribe') {
      throw new Error(`Command "${path}" is classified as ${commandClass} and cannot open subscriptions.`);
    }

    const authOptions = ipcAuthOptions();
    await reconcileKbBoot();
    const client = await ensure(resolvePluginRoot());
    return client.subscribe<TResult>(method, params, {
      timeoutMs: HEALTH_TIMEOUT_MS,
      ...options,
      ...authOptions,
    });
  };

  const readStore = () => getSharedReadCoralStore(projectRoot);

  return {
    createSession: async (provider, prompt, options = {}) => {
      return request<AcceptedLaunchResponse>(
        'sessions.create',
        await buildProviderTransportContextBody({ provider, prompt, ...options }, defaultContext, providerRegistry, [
          provider,
        ]),
      );
    },
    workflow: async (expression, options) => {
      const provider = options.provider ?? 'claude';
      const providers = workflowProviderNames(normalizeAst(parseExpression(expression), provider), provider);
      return request<AcceptedLaunchResponse>(
        'workflow.run',
        await buildProviderTransportContextBody(
          { expression, ...options },
          defaultContext,
          providerRegistry,
          providers,
        ),
      );
    },
    listJobs: async (options = {}) => {
      const filters = {
        ...(options.allProjects === true ? {} : { projectRoot: options.projectRoot ?? projectRoot }),
        ...(options.phase !== undefined ? { phase: options.phase } : {}),
        ...(options.provider !== undefined ? { provider: options.provider } : {}),
        ...(options.all === true ? { all: true } : {}),
      };
      if (commandClass === 'directRead') {
        return { jobs: readStore().jobs.list(filters) };
      }
      return request<JobsListResponse>('jobs.list', filters);
    },
    detailJob: async (jobId) =>
      request<JobDetailResponse>('jobs.detail', buildProjectScopedQuery({ jobId }, defaultContext)),
    abortJobs: async (jobIds) =>
      request<AbortResult>('jobs.abort', buildProjectScopedQuery({ jobs: jobIds }, defaultContext)),
    discussSeed: async (args) => request<PersonaSeedOutput>('discuss.persona.generate', args),
    discussStart: async (args) =>
      request<DiscussStartResponse>(
        'discuss.session.create',
        await buildProviderTransportContextBody(
          args,
          defaultContext,
          providerRegistry,
          discussProviderNames(args.agents),
        ),
      ),
    discussWatch: async (session, cursor) => {
      if (commandClass === 'directRead') {
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
      if (commandClass === 'directRead') {
        throw new Error(`Command "${path}" is classified as directRead and cannot issue served KB searches.`);
      }

      return request<KbSearchResponse>('kb.entries.search', {
        q: args.query,
        ...(args.scope === undefined ? {} : { scope: args.scope }),
        ...(args.top_k === undefined ? {} : { top_k: args.top_k }),
        ...(args.mode === undefined ? {} : { mode: args.mode }),
      });
    },
    kbDiagnose: async (_args = {}) => {
      if (commandClass === 'directRead') {
        return readStore().kb.diagnose();
      }

      return request<KbDiagnoseResult>('kb.diagnose', {});
    },
    kbPrinciples: async (args) => {
      if (commandClass === 'directRead') {
        return readStore().kb.listPrinciples(args);
      }

      return request<KbPrinciplesResult>('kb.principles.list', {
        ...(args.query === undefined ? {} : { q: args.query }),
        ...(args.top_k === undefined ? {} : { top_k: args.top_k }),
        ...(args.verbose === undefined ? {} : { verbose: args.verbose }),
      });
    },
    kbRead: async (args) => {
      if (commandClass === 'directRead') {
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
      if (commandClass === 'directRead') {
        return readStore().kb.listWikis();
      }

      return request<KbWikiListResult>('kb.wiki.list', {});
    },
    kbWikiRead: async (args) => request<KbReadResult>('kb.wiki.read', { slug: args.slug }),
    kbWakeUp: async (args = {}) => {
      if (commandClass === 'directRead') {
        return readStore().kb.wakeUp(args);
      }

      return request<KbWakeUpResponse>('kb.wake_up', args);
    },
    kbSourceImport: async (args) =>
      request<KbSourceImportResponse>('kb.source.create', buildKbMutationTransportContextBody(args, defaultContext)),
    kbSourceList: async () => {
      if (commandClass === 'directRead') {
        return readStore().kb.listSources();
      }

      return request<KbSourceListResult>('kb.source.list', {});
    },
    kbSourceDelete: async (args) =>
      request<KbSourceDeleteResponse>(
        'kb.source.delete',
        buildKbMutationTransportContextBody({ slug: args.slug }, defaultContext),
      ),
    kbCommunityListStale: async () => {
      if (commandClass === 'directRead') {
        return readStore().kb.listStaleCommunities();
      }

      return request<Array<{ slug: string; level: number }>>('kb.community.list-stale', {});
    },
    kbCommunitySummaryInput: async (args) => {
      if (commandClass === 'directRead') {
        return readStore().kb.readCommunitySummaryInput(args.slug);
      }

      return request<{ slug: string; level: number; kind: 'leaf' | 'parent'; input: string }>(
        'kb.community.summary-input',
        {
          slug: args.slug,
        },
      );
    },
    kbCommunitySetSummary: async (args) =>
      request<{ slug: string }>(
        'kb.community.set-summary',
        buildKbMutationTransportContextBody({ slug: args.slug, summary: args.summary }, defaultContext),
      ),
    kbMemo: async (args) =>
      request<KbMemoResponse>('kb.memo.create', buildKbMutationTransportContextBody(args, defaultContext)),
    kbMemoList: async (args) => {
      const owner = resolveMemoOwner(args.owner, defaultContext);

      if (commandClass === 'directRead') {
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
