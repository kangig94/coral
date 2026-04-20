declare const __PLUGIN_ROOT__: string;

import { existsSync, readFileSync } from 'node:fs';
import type { Command } from 'commander';

import {
  BackendToolHttpError,
  type AcceptedLaunchResponse,
  type CallerContext,
  type DiscussAbortResponse,
  type DiscussStartResponse,
  type JobsListResponse,
  type KbDeleteResponse,
  type KbMemoResponse,
  type KbPromoteResponse,
  type KbSourceDeleteResponse,
  type KbSourceImportResponse,
  type KbUpdateResponse,
  type SessionCreateResponse,
  type SessionMessageResponse,
  type WorkflowLaunchResponse,
} from '../client/http-client.js';
import type { BidResult, PersonaSeedOutput, SpeechResult } from '../discuss/session-types.js';
import type { WatchState } from '../discuss/watch.js';
import { pluginRootNamespace } from '../infra/paths.js';
import type { JobStatus } from '../jobs/views.js';
import type {
  KbDeleteInput,
  KbMemoDeleteInput,
  KbMemoDeleteResult,
  KbMemoInput,
  KbMemoListInput,
  KbMemoListResult,
  KbMemoPurgeInput,
  KbMemoPurgeResult,
  KbPrinciplesInput,
  KbPrinciplesResult,
  KbPromoteInput,
  KbReadInput,
  KbReadResult,
  KbReindexInput,
  KbSearchInput,
  KbSearchResponse,
  KbSourceDeleteInput,
  KbSourceListResult,
  KbSourcePersistInput,
  KbUpdateInput,
  ReindexResult,
} from '../kb/entry-types.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { createRealRuntime } from '../runtime/real.js';
import type { AbortResult } from '../shared/execution-contracts.js';
import { HEALTH_TIMEOUT_MS, TOOL_TIMEOUT_MS } from '../shared/sse-parser.js';
import { collectCoralEnv, readBuildFlavor } from '../shared/utils.js';
import { buildErrorEnvelope, UsageError } from './errors.js';
import {
  formatErrorEnvelope,
  formatLaunch,
} from './format.js';
import { launchAndFollow } from './follow.js';
import { isJsonObject } from './parse.js';
import type { IpcSubscription, IpcSubscriptionOptions } from '../transport/ipc/client.js';
import { ensure } from '../transport/ipc/ensure.js';
import { classifyCommand, commandPath } from './command-class-map.js';
import { CoralStore, openStoreDatabase } from '../store/index.js';
import { createDefaultStoreReadContext } from '../store/read-context.js';
import { ensureStoreMigrationsDir } from '../store/migrations.js';
import { storePaths } from '../store/paths.js';

type CliOutputFormat = 'text' | 'json';

export type ReadCoralStoreHandle = {
  store: CoralStore;
  close(): void;
};

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
  createSession(provider: string, prompt: string, options?: CreateSessionRequestOptions): Promise<SessionCreateResponse>;
  sendMessage(sessionId: string, prompt: string, options?: SessionRequestOptions): Promise<SessionMessageResponse>;
  workflow(expression: string, options: WorkflowRequestOptions): Promise<WorkflowLaunchResponse>;
  listJobs(options?: JobsListOptions): Promise<JobsListResponse>;
  discussSeed(args: DiscussSeedArgs): Promise<PersonaSeedOutput>;
  discussStart(args: {
    agents: Array<{ name: string; persona: string }>;
    topic?: string;
    config?: { min_bid_delay_ms?: number };
  }): Promise<DiscussStartResponse>;
  discussWatch(session: string, cursor?: number): Promise<WatchState>;
  discussBid(args: {
    session: string;
    agent_name: string;
    score: number;
    thought: string;
  }): Promise<BidResult>;
  discussSpeech(args: {
    session: string;
    agent_name: string;
    content: string;
  }): Promise<SpeechResult>;
  discussAbort(session: string): Promise<DiscussAbortResponse>;
  kbSearch(args: KbSearchInput): Promise<KbSearchResponse>;
  kbPrinciples(args: KbPrinciplesInput): Promise<KbPrinciplesResult>;
  kbRead(args: KbReadInput): Promise<KbReadResult>;
  kbPromote(args: KbPromoteInput): Promise<KbPromoteResponse>;
  kbUpdate(args: KbUpdateInput): Promise<KbUpdateResponse>;
  kbDelete(args: KbDeleteInput): Promise<KbDeleteResponse>;
  kbSourceImport(args: KbSourcePersistInput): Promise<KbSourceImportResponse>;
  kbSourceList(): Promise<KbSourceListResult>;
  kbSourceDelete(args: KbSourceDeleteInput): Promise<KbSourceDeleteResponse>;
  kbMemo(args: KbMemoInput): Promise<KbMemoResponse>;
  kbMemoList(args: KbMemoListInput): Promise<KbMemoListResult>;
  kbMemoDelete(args: KbMemoDeleteInput): Promise<KbMemoDeleteResult>;
  kbMemoPurge(args: KbMemoPurgeInput): Promise<KbMemoPurgeResult>;
  kbReindex(args?: KbReindexInput): Promise<ReindexResult>;
  subscribe<TResult>(
    method: string,
    params?: unknown,
    options?: IpcSubscriptionOptions,
  ): Promise<IpcSubscription<TResult>>;
};

export type ProviderRunOptions = {
  input?: string[];
  session?: string;
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
  scope?: 'notes' | 'communities' | 'sources' | 'all';
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

const pluginRoot = typeof __PLUGIN_ROOT__ === 'string' ? __PLUGIN_ROOT__ : (process.env.CLAUDE_PLUGIN_ROOT ?? '');

export function getProviderNames(providerRegistry: ProviderRegistry): string[] {
  return providerRegistry.getAll().map((provider) => provider.name);
}

export function resolveFilePath(filePath: string): string {
  if (existsSync(filePath)) return filePath;
  if (!filePath.endsWith('.md')) {
    const withMd = `${filePath}.md`;
    if (existsSync(withMd)) return withMd;
  }
  return filePath;
}

export function resolveInput(values: string[]): string {
  // Each token is resolved independently: existing files are read, other tokens stay literal.
  // Multi-value inputs are joined with spaces, which recovers prompts that a shell split into
  // multiple argv entries (e.g. unquoted `-i hello world`) and prompts that the cli-resolve
  // hook partially materialized into a temp file alongside adjacent literal tokens.
  return values
    .map((token) => (existsSync(token) ? readFileSync(token, 'utf8') : token))
    .join(' ');
}

type CachedReadStore = {
  key: string;
  handle: ReadCoralStoreHandle;
};

let cachedReadStore: CachedReadStore | null = null;
let readStoreCleanupRegistered = false;

function createDefaultCallerContext(projectRoot: string): CallerContext {
  return {
    pluginRoot,
    projectRoot,
    coralEnv: collectCoralEnv(),
  };
}

function buildTransportContextBody(args: Record<string, unknown>, context: CallerContext): Record<string, unknown> {
  const body: Record<string, unknown> = {
    ...args,
    projectRoot: context.projectRoot,
  };

  const owner = context.coralEnv.CORAL_OWNER;
  const effort = context.coralEnv.CORAL_EFFORT;
  const claudeModelCap = context.coralEnv.CORAL_CLAUDE_MODEL_CAP;

  if (body.owner === undefined && typeof owner === 'string' && owner.length > 0) {
    body.owner = owner;
  }
  if (body.effort === undefined && typeof effort === 'string' && effort.length > 0) {
    body.effort = effort;
  }
  if (body.claudeModelCap === undefined && typeof claudeModelCap === 'string' && claudeModelCap.length > 0) {
    body.claudeModelCap = claudeModelCap;
  }

  return body;
}

function buildProjectScopedQuery(
  args: Record<string, unknown>,
  context: CallerContext,
): Record<string, unknown> {
  return {
    ...args,
    projectRoot: context.projectRoot,
  };
}

function resolveMemoOwner(owner: string | undefined, context: CallerContext): string | undefined {
  if (owner !== undefined) {
    return owner;
  }

  const fallback = context.coralEnv.CORAL_OWNER;
  return typeof fallback === 'string' && fallback.length > 0 ? fallback : undefined;
}

function closeCachedReadStore(): void {
  if (!cachedReadStore) {
    return;
  }

  cachedReadStore.handle.close();
  cachedReadStore = null;
}

function registerReadStoreCleanup(): void {
  if (readStoreCleanupRegistered) {
    return;
  }

  readStoreCleanupRegistered = true;
  process.once('exit', closeCachedReadStore);
  process.once('beforeExit', closeCachedReadStore);
}

function readStoreCacheKey(projectRoot: string): string {
  return JSON.stringify({
    pluginRoot,
    projectRoot,
    flavor: readBuildFlavor(pluginRoot || projectRoot),
  });
}

function getSharedReadCoralStore(projectRoot: string): CoralStore {
  const key = readStoreCacheKey(projectRoot);
  if (cachedReadStore?.key === key) {
    return cachedReadStore.handle.store;
  }

  closeCachedReadStore();
  cachedReadStore = {
    key,
    handle: openReadCoralStore(projectRoot),
  };
  registerReadStoreCleanup();
  return cachedReadStore.handle.store;
}

function remoteDispatchUnavailable(commandName: string): never {
  throw new UsageError(
    `Command "${commandName}" is reserved for remote dispatch, but the CLI does not expose --remote <url> in this phase.`,
  );
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
  const defaultContext = createDefaultCallerContext(projectRoot);

  const request = async <TResult>(method: string, params?: unknown): Promise<TResult> => {
    if (commandClass === 'remote') {
      remoteDispatchUnavailable(path);
    }

    const client = await ensure(pluginRoot || undefined);
    return client.request<TResult>(method, params, { timeoutMs: TOOL_TIMEOUT_MS });
  };

  const subscribe = async <TResult>(
    method: string,
    params?: unknown,
    options?: IpcSubscriptionOptions,
  ): Promise<IpcSubscription<TResult>> => {
    if (commandClass === 'remote') {
      remoteDispatchUnavailable(path);
    }
    if (commandClass !== 'subscribe') {
      throw new Error(`Command "${path}" is classified as ${commandClass} and cannot open subscriptions.`);
    }

    const client = await ensure(pluginRoot || undefined);
    return client.subscribe<TResult>(method, params, {
      timeoutMs: HEALTH_TIMEOUT_MS,
      ...options,
    });
  };

  const readStore = () => getSharedReadCoralStore(projectRoot);

  return {
    createSession: async (provider, prompt, options = {}) => {
      if (commandClass === 'remote') {
        remoteDispatchUnavailable(path);
      }

      return request<SessionCreateResponse>(
        'sessions.create',
        buildTransportContextBody({ provider, prompt, ...options }, defaultContext),
      );
    },
    sendMessage: async (sessionId, prompt, options = {}) => {
      if (commandClass === 'remote') {
        remoteDispatchUnavailable(path);
      }

      return request<SessionMessageResponse>(
        'sessions.message',
        buildTransportContextBody({ sessionId, prompt, ...options }, defaultContext),
      );
    },
    workflow: async (expression, options) => {
      if (commandClass === 'remote') {
        remoteDispatchUnavailable(path);
      }

      return request<WorkflowLaunchResponse>(
        'workflow.run',
        buildTransportContextBody({ expression, ...options }, defaultContext),
      );
    },
    listJobs: async (options = {}) => {
      if (commandClass === 'read') {
        return {
          jobs: await Promise.resolve(
            readStore().jobs.list({
              projectRoot: options.projectRoot ?? projectRoot,
              ...(options.phase !== undefined ? { phase: options.phase } : {}),
              ...(options.provider !== undefined ? { provider: options.provider } : {}),
              ...(options.all === true ? { all: true } : {}),
            }),
          ),
        };
      }

      return request<JobsListResponse>('jobs.list', {
        projectRoot: options.projectRoot ?? defaultContext.projectRoot,
        ...(options.phase !== undefined ? { phase: options.phase } : {}),
        ...(options.provider !== undefined ? { provider: options.provider } : {}),
        ...(options.all === true ? { all: true } : {}),
      });
    },
    abortJobs: async (jobIds) =>
      await request<AbortResult>('jobs.abort', buildProjectScopedQuery({ jobs: jobIds }, defaultContext)),
    discussSeed: async (args) => await request<PersonaSeedOutput>('discuss.persona.generate', args),
    discussStart: async (args) =>
      await request<DiscussStartResponse>('discuss.session.create', buildTransportContextBody(args, defaultContext)),
    discussWatch: async (session, cursor) =>
      await request<WatchState>('discuss.session.events', buildProjectScopedQuery({
        sessionId: session,
        ...(cursor === undefined ? {} : { cursor }),
      }, defaultContext)),
    discussBid: async (args) =>
      await request<BidResult>(
        'discuss.session.bid',
        buildTransportContextBody({ ...args, sessionId: args.session }, defaultContext),
      ),
    discussSpeech: async (args) =>
      await request<SpeechResult>(
        'discuss.session.speech',
        buildTransportContextBody({ ...args, sessionId: args.session }, defaultContext),
      ),
    discussAbort: async (session) =>
      await request<DiscussAbortResponse>(
        'discuss.session.delete',
        buildProjectScopedQuery({ sessionId: session }, defaultContext),
      ),
    kbSearch: async (args) => {
      if (commandClass === 'read') {
        return await Promise.resolve(readStore().kb.search(args));
      }

      return request<KbSearchResponse>('kb.entries.search', {
        q: args.query,
        ...(args.scope === undefined ? {} : { scope: args.scope }),
        ...(args.top_k === undefined ? {} : { top_k: args.top_k }),
      });
    },
    kbPrinciples: async (args) => {
      if (commandClass === 'read') {
        return await Promise.resolve(readStore().kb.listPrinciples(args));
      }

      return request<KbPrinciplesResult>('kb.principles.list', {
        ...(args.query === undefined ? {} : { q: args.query }),
        ...(args.top_k === undefined ? {} : { top_k: args.top_k }),
        ...(args.verbose === undefined ? {} : { verbose: args.verbose }),
      });
    },
    kbRead: async (args) => {
      if (commandClass === 'read') {
        return await Promise.resolve(readStore().kb.read(args));
      }

      throw new Error(`Command "${path}" is classified as ${commandClass} and cannot issue direct KB reads.`);
    },
    kbPromote: async (args) =>
      await request<KbPromoteResponse>('kb.note.create', buildTransportContextBody(args, defaultContext)),
    kbUpdate: async (args) =>
      await request<KbUpdateResponse>(
        'kb.note.update',
        buildTransportContextBody({ ...args, slug: args.note }, defaultContext),
      ),
    kbDelete: async (args) =>
      await request<KbDeleteResponse>('kb.note.delete', {
        slug: args.note,
      }),
    kbSourceImport: async (args) =>
      await request<KbSourceImportResponse>('kb.source.create', buildTransportContextBody(args, defaultContext)),
    kbSourceList: async () => {
      if (commandClass === 'read') {
        return await Promise.resolve(readStore().kb.listSources());
      }

      return request<KbSourceListResult>('kb.source.list', {});
    },
    kbSourceDelete: async (args) =>
      await request<KbSourceDeleteResponse>('kb.source.delete', {
        slug: args.slug,
      }),
    kbMemo: async (args) =>
      await request<KbMemoResponse>('kb.memo.create', buildTransportContextBody(args, defaultContext)),
    kbMemoList: async (args) => {
      const owner = resolveMemoOwner(args.owner, defaultContext);

      if (commandClass === 'read') {
        return await Promise.resolve(readStore().kb.listMemos(owner === undefined ? {} : { owner }));
      }

      return request<KbMemoListResult>(
        'kb.memo.list',
        buildProjectScopedQuery(owner === undefined ? {} : { owner }, defaultContext),
      );
    },
    kbMemoDelete: async (args) =>
      await request<KbMemoDeleteResult>(
        'kb.memo.delete',
        buildProjectScopedQuery(
          {
            pattern: args.pattern,
            ...(resolveMemoOwner(args.owner, defaultContext) === undefined
              ? {}
              : { owner: resolveMemoOwner(args.owner, defaultContext) }),
          },
          defaultContext,
        ),
      ),
    kbMemoPurge: async (args) =>
      await request<KbMemoPurgeResult>(
        'kb.memo.delete',
        buildProjectScopedQuery(
          {
            all: true,
            ...(resolveMemoOwner(args.owner, defaultContext) === undefined
              ? {}
              : { owner: resolveMemoOwner(args.owner, defaultContext) }),
          },
          defaultContext,
        ),
      ),
    kbReindex: async (_args = {}) =>
      await request<ReindexResult>('kb.reindex', buildTransportContextBody({}, defaultContext)),
    subscribe,
  };
}

export function openReadCoralStore(projectRoot: string): ReadCoralStoreHandle {
  const runtime = createRealRuntime();
  const flavor = readBuildFlavor(pluginRoot || projectRoot);
  const dbPath = storePaths(flavor).dbFile;
  const namespace = pluginRoot
    ? (() => {
        try {
          return pluginRootNamespace(pluginRoot);
        } catch {
          return undefined;
        }
      })()
    : undefined;

  const db = existsSync(dbPath)
    ? openStoreDatabase({
        path: dbPath,
        storage: runtime.storage,
        readonly: true,
      })
    : openStoreDatabase({
        path: ':memory:',
        storage: runtime.storage,
        migrationsDir: ensureStoreMigrationsDir(runtime.storage),
      });

  return {
    store: new CoralStore(db, createDefaultStoreReadContext(), {
      namespace,
      projectRoot,
      ...(pluginRoot ? { pluginRoot } : {}),
    }),
    close: () => db.close(),
  };
}

export async function withReadCoralStore<T>(
  projectRoot: string,
  read: (store: CoralStore) => Promise<T> | T,
): Promise<T> {
  const handle = openReadCoralStore(projectRoot);

  try {
    return await read(handle.store);
  } finally {
    handle.close();
  }
}

export function getOutputFormat(command: Command): CliOutputFormat {
  return command.optsWithGlobals<{ outputFormat?: string }>().outputFormat === 'json' ? 'json' : 'text';
}

export function getCliDisplayPrefix(argv: readonly string[] = process.argv): string {
  return argv[0]?.match(/node(\.exe)?$/) ? `node "${argv[1]}"` : (argv[0] ?? 'coral-cli');
}

export function emit<T>(result: T, outputFormat: CliOutputFormat, textFormatter?: (data: T) => string): void {
  const text = outputFormat === 'text' && textFormatter !== undefined ? textFormatter(result) : JSON.stringify(result);
  process.stdout.write(text + '\n');
}

export function emitError(error: unknown): void {
  const { envelope, exitCode } = buildErrorEnvelope(error);
  const statusCode = error instanceof BackendToolHttpError ? error.statusCode : undefined;
  process.stderr.write(formatErrorEnvelope(envelope, statusCode) + '\n');
  process.exitCode = exitCode;
}

export function parseIntegerFlag(flagName: string, value: string): number {
  if (!/^-?\d+$/.test(value)) {
    throw new UsageError(`${flagName} must be an integer`);
  }

  return Number.parseInt(value, 10);
}

export function parseJobIds(raw: string): string[] {
  const jobIds = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (jobIds.length === 0) {
    throw new UsageError('--jobs must include at least one job ID');
  }

  return jobIds;
}

export function isAcceptedLaunchResponse(value: unknown): value is AcceptedLaunchResponse {
  if (!isJsonObject(value) || typeof value.launchState !== 'string') {
    return false;
  }

  return (
    (value.launchState === 'running' || value.launchState === 'queued') &&
    typeof value.job === 'string' &&
    typeof value.session === 'string'
  );
}

export function emitAcceptedLaunchResponse(decision: AcceptedLaunchResponse): void {
  process.stdout.write(formatLaunch(decision) + '\n');
}

export function getTerminalContext(): { isTTY: boolean; columns: number } {
  return {
    isTTY: process.stdout.isTTY === true,
    columns: process.stdout.columns ?? 80,
  };
}

export async function handleLaunchResult(
  result: unknown,
  detach: boolean | undefined,
  client: AbortCapableClient,
): Promise<void> {
  if (!isAcceptedLaunchResponse(result)) {
    emitError(new Error(`Expected accepted launch response, received: ${JSON.stringify(result)}`));
    return;
  }

  if (detach) {
    emitAcceptedLaunchResponse(result);
    return;
  }

  // Successful follow returns the terminal job exit code (0-255).
  // Follow-level failures route through emitError and return the envelope exit code instead.
  process.exitCode = await launchAndFollow({
    launchResult: result,
    abortJob: async (jobId) => {
      await client.abortJobs([jobId]);
    },
    pluginRoot,
    projectRoot: process.cwd(),
    emitError,
    ...getTerminalContext(),
  });
}

export function getPluginRoot(): string {
  return pluginRoot;
}
