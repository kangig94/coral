declare const __PLUGIN_ROOT__: string;
declare const __VERSION__: string;

import { existsSync, readFileSync } from 'node:fs';
import { Command, Option } from 'commander';

import {
  BackendClient,
  BackendToolHttpError,
  type CallerContext,
} from '../client/http-client.js';
import { assertOwnerId, collectCoralEnv } from '../shared/mcp-utils.js';
import { ensureBackend } from '../client/backend-lifecycle.js';
import {
  getBackendStatusFull,
  shutdownBackend,
  streamWait,
  type WaitCursorRef,
} from '../bridge/backend-client.js';
import type { AbortResult } from '../execution/abort-registry.js';
import type { ListResult } from '../execution/service.js';
import {
  discussParticipateSchema,
  discussSeedSchema,
  discussStartSchema,
} from '../discuss/schemas.js';
import type {
  BidResult,
  PersonaSeedOutput,
  SpeechResult,
} from '../discuss/types.js';
import { MAX_INLINE } from '../shared/schemas.js';
import type { LaunchDecision, WaitStreamEvent } from '../shared/types.js';
import {
  type DiscussAbortResult,
  type DiscussStartResult,
  formatAbortResult,
  formatBackendStatus,
  formatKbDelete,
  formatKbPrinciples,
  formatKbMemo,
  formatKbMemoDelete,
  formatKbMemoList,
  formatKbMemoPurge,
  formatKbPromote,
  formatKbRead,
  formatKbReindex,
  formatKbSearch,
  formatKbUpdate,
  formatDiscussAbort,
  formatDiscussParticipate,
  formatDiscussStart,
  formatDiscussWatch,
  formatError,
  formatLaunchDecision,
  formatPersonaSeed,
  formatProviderList,
  formatShutdown,
  formatWaitProgress,
  formatWaitQueued,
  formatWaitTerminal,
  formatWaitTimeout,
  renderWaitLine,
  type WaitRenderContext,
} from './format.js';
import { launchAndFollow } from './follow.js';
import {
  isJsonObject,
  parseAgentSpec,
  parseAxisSpec,
  parseInputJson,
  type JsonObject,
} from './parse.js';
import { registerBuiltInProviders } from '../providers/bootstrap.js';
import { getAllNewProviders } from '../providers/registry.js';

/** Return registered provider names. Built-ins are registered on first call. */
function getProviderNames(): string[] {
  registerBuiltInProviders();
  return getAllNewProviders().map((p) => p.name);
}
const pluginRoot = typeof __PLUGIN_ROOT__ === 'string' ? __PLUGIN_ROOT__ : (process.env.CLAUDE_PLUGIN_ROOT ?? '');

type ProviderExecOptions = {
  prompt: string;
  session?: string;
  workDir?: string;
  model?: string;
  detach?: boolean;
};

type ProviderForkOptions = {
  session: string;
  prompt?: string;
  workDir?: string;
  model?: string;
  detach?: boolean;
};

type ProviderCoralOptions = {
  prompt: string;
  session?: string;
  workDir?: string;
  owner?: string;
  detach?: boolean;
};

type WaitOptions = {
  jobs: string;
  timeout: string;
  cursor?: string;
  embed?: boolean;
};

type AbortOptions = {
  jobs: string;
};

type WorkflowOptions = {
  expression?: string;
  initPrompt?: string;
  context?: string;
  provider?: string;
  workDir?: string;
  staleTimeoutSeconds?: string;
  inputJson?: string;
  atoms?: string;
  detach?: boolean;
  owner?: string;
};

type DiscussSeedOptions = {
  inputJson?: string;
  axis?: string[];
  count?: string;
  seed?: string;
};

type DiscussStartOptions = {
  inputJson?: string;
  agent?: string[];
  topic?: string;
};

type DiscussWatchOptions = {
  session: string;
  cursor?: string;
};

type DiscussParticipateOptions = {
  inputJson?: string;
  session?: string;
  agentName?: string;
  score?: string;
  thought?: string;
  content?: string;
};

type DiscussAbortOptions = {
  session: string;
};

type KbSearchOptions = {
  topK?: string;
};

type KbPrinciplesOptions = {
  query?: string;
  topK?: string;
  verbose?: boolean;
};

type KbPromoteOptions = {
  memo?: string;
  title?: string;
  contentFile?: string;
  domain?: string;
  topic?: string;
};

type KbUpdateOptions = {
  title?: string;
  contentFile?: string;
};

function resolveFilePath(filePath: string): string {
  if (existsSync(filePath)) return filePath;
  if (!filePath.endsWith('.md')) {
    const withMd = `${filePath}.md`;
    if (existsSync(withMd)) return withMd;
  }
  return filePath;
}

function makeClient(projectRoot: string): BackendClient {
  const defaultContext: CallerContext = { pluginRoot, projectRoot, coralEnv: collectCoralEnv() };
  return new BackendClient({
    ensureBackend: () => ensureBackend(pluginRoot || undefined),
    defaultContext,
  });
}

function normalizeResult(result: unknown): { output: unknown; isError: boolean } {
  if (
    isJsonObject(result)
    && typeof result.isError === 'boolean'
    && Array.isArray(result.content)
    && result.content.length > 0
  ) {
    const first = result.content[0];
    if (isJsonObject(first) && typeof first.text === 'string') {
      try {
        return { output: JSON.parse(first.text), isError: result.isError };
      } catch {
        return { output: first.text, isError: result.isError };
      }
    }
  }

  if (isJsonObject(result) && result.status === 'rejected') {
    return { output: result, isError: true };
  }

  // Non-MCP response shape — treat as success and emit as-is
  return { output: result, isError: false };
}

export function getOutputFormat(command: Command): 'text' | 'json' {
  return command.optsWithGlobals<{ outputFormat?: string }>().outputFormat === 'json'
    ? 'json'
    : 'text';
}

function getCliDisplayPrefix(argv: readonly string[] = process.argv): string {
  return argv[0]?.match(/node(\.exe)?$/)
    ? `node "${argv[1]}"`
    : (argv[0] ?? 'coral-cli');
}

function emit(
  result: unknown,
  outputFormat: 'text' | 'json',
  textFormatter?: (data: unknown) => string,
): void {
  const { output, isError } = normalizeResult(result);

  if (isError) {
    const text = outputFormat === 'text' ? formatError(output) : JSON.stringify(output);
    process.stderr.write(text + '\n');
    process.exitCode = 1;
    return;
  }

  const text = outputFormat === 'text' && textFormatter !== undefined
    ? textFormatter(output)
    : JSON.stringify(output);
  process.stdout.write(text + '\n');
}

export function emitError(error: unknown, outputFormat: 'text' | 'json'): void {
  if (outputFormat === 'text') {
    process.stderr.write(formatError(error) + '\n');
    process.exitCode = 1;
    return;
  }

  if (error instanceof BackendToolHttpError) {
    process.stderr.write(JSON.stringify({ error: true, statusCode: error.statusCode, body: error.body }) + '\n');
  } else if (error instanceof Error) {
    process.stderr.write(JSON.stringify({ error: true, message: error.message }) + '\n');
  } else {
    process.stderr.write(JSON.stringify({ error: true, message: String(error) }) + '\n');
  }
  process.exitCode = 1;
}

function parseIntegerFlag(flagName: string, value: string): number {
  if (!/^-?\d+$/.test(value)) {
    throw new Error(`${flagName} must be an integer`);
  }

  return Number.parseInt(value, 10);
}

function parseJobIds(raw: string): string[] {
  const jobIds = raw.split(',').map((entry) => entry.trim()).filter(Boolean);
  if (jobIds.length === 0) {
    throw new Error('--jobs must include at least one job ID');
  }

  return jobIds;
}

export function isLaunchDecision(value: unknown): value is LaunchDecision {
  if (!isJsonObject(value) || typeof value.status !== 'string') {
    return false;
  }

  if (value.status === 'running' || value.status === 'queued') {
    return typeof value.job === 'string' && typeof value.session === 'string';
  }

  if (value.status === 'rejected') {
    return value.phase === 'preflight'
      && typeof value.code === 'string'
      && typeof value.message === 'string';
  }

  return false;
}

export function emitLaunchDecision(
  decision: LaunchDecision,
  outputFormat: 'text' | 'json',
): void {
  const text = outputFormat === 'text'
    ? formatLaunchDecision(decision)
    : JSON.stringify(decision);
  process.stdout.write(text + '\n');
}

export function emitRejectedLaunchDecision(
  decision: Extract<LaunchDecision, { status: 'rejected' }>,
  outputFormat: 'text' | 'json',
): void {
  const text = outputFormat === 'text'
    ? formatLaunchDecision(decision)
    : JSON.stringify(decision);
  process.stderr.write(text + '\n');
  process.exitCode = 1;
}

function getTerminalContext(): { isTTY: boolean; columns: number } {
  return {
    isTTY: process.stdout.isTTY === true,
    columns: process.stdout.columns ?? 80,
  };
}

async function handleLaunchResult(
  result: unknown,
  detach: boolean | undefined,
  outputFormat: 'text' | 'json',
  client: BackendClient,
): Promise<void> {
  const normalized = normalizeResult(result);

  if (normalized.isError) {
    if (isLaunchDecision(normalized.output) && normalized.output.status === 'rejected') {
      emitRejectedLaunchDecision(normalized.output, outputFormat);
    } else {
      emitError(normalized.output, outputFormat);
    }
    return;
  }

  if (detach) {
    emitLaunchDecision(normalized.output as LaunchDecision, outputFormat);
    return;
  }

  process.exitCode = await launchAndFollow({
    launchResult: normalized.output as Extract<LaunchDecision, { status: 'running' | 'queued' }>,
    abortJob: async (jobId) => {
      await client.abortJobs([jobId]);
    },
    pluginRoot,
    projectRoot: process.cwd(),
    outputFormat,
    ...getTerminalContext(),
  });
}

type WaitOutputRecord = {
  cursor: string | null;
  event: unknown;
};

function shapeWaitOutputRecord(
  event: WaitStreamEvent,
  cursor: string | null,
  embed: boolean,
): WaitOutputRecord {
  if (event.type !== 'terminal') {
    return { cursor, event };
  }

  const {
    resultPath,
    result: { content: rawContent, ...resultMeta },
  } = event;
  const pathFirstEvent = {
    ...event,
    result: {
      ...resultMeta,
      path: resultPath,
    },
  };
  const { resultPath: _resultPath, ...pathFirstEventWithoutResultPath } = pathFirstEvent;
  const pathOnlyRecord: WaitOutputRecord = {
    cursor,
    event: pathFirstEventWithoutResultPath,
  };

  if (!embed) {
    return pathOnlyRecord;
  }

  let text: string | undefined;
  if (event.result.workflow !== undefined) {
    try {
      text = readFileSync(resultPath, 'utf8');
    } catch {
      // Fall back to path-only output when the artifact is unavailable.
    }
  } else {
    text = rawContent;
  }

  if (text === undefined) {
    return pathOnlyRecord;
  }

  const embeddedRecord: WaitOutputRecord = {
    cursor,
    event: {
      ...pathFirstEventWithoutResultPath,
      result: {
        ...resultMeta,
        path: resultPath,
        content: text,
      },
    },
  };

  return JSON.stringify(embeddedRecord).length <= MAX_INLINE
    ? embeddedRecord
    : pathOnlyRecord;
}

export function normalizeProviderArgv(argv: readonly string[]): string[] {
  if (argv.length < 4) {
    return argv.slice();
  }

  const [nodePath, scriptPath, provider, dispatchToken] = argv;

  if (!getProviderNames().includes(provider)) {
    return argv.slice();
  }

  const match = /^coral:([a-z0-9][a-z0-9-]*)$/.exec(dispatchToken);
  if (!match) {
    return argv.slice();
  }

  return [nodePath, scriptPath, provider, 'coral', match[1], ...argv.slice(4)];
}

function registerProviderCommands(program: Command): void {
  for (const providerName of getProviderNames()) {
    const provider = program
      .command(providerName)
      .description(`${providerName} provider operations`);

    const execCommand = provider.command('exec');
    execCommand
      .description('Execute a prompt')
      .requiredOption('--prompt <text>', 'Prompt text')
      .option('--session <id>', 'Resume session ID')
      .option('--work-dir <path>', 'Working directory')
      .option('--model <model>', 'Model override')
      .option('-d, --detach', 'Return launch decision without waiting')
      .action(async (opts: ProviderExecOptions) => {
        const outputFormat = getOutputFormat(execCommand);

        try {
          const client = makeClient(process.cwd());
          const result = await client.providerExec(providerName, opts.prompt, {
            session: opts.session,
            work_dir: opts.workDir,
            model: opts.model,
          });
          await handleLaunchResult(result, opts.detach, outputFormat, client);
        } catch (error) {
          emitError(error, outputFormat);
        }
      });

    const forkCommand = provider.command('fork');
    forkCommand
      .description('Branch from an existing session, optionally continuing with a new prompt')
      .requiredOption('--session <id>', 'Source session ID')
      .option('--prompt <text>', 'Follow-up prompt')
      .option('--work-dir <path>', 'Working directory')
      .option('--model <model>', 'Model override')
      .option('-d, --detach', 'Return launch decision without waiting')
      .action(async (opts: ProviderForkOptions) => {
        const outputFormat = getOutputFormat(forkCommand);

        try {
          const client = makeClient(process.cwd());
          const result = await client.providerFork(providerName, opts.session, opts.prompt, {
            work_dir: opts.workDir,
            model: opts.model,
          });
          await handleLaunchResult(result, opts.detach, outputFormat, client);
        } catch (error) {
          emitError(error, outputFormat);
        }
      });

    const listCommand = provider.command('list');
    listCommand
      .description('List sessions')
      .action(async () => {
        const outputFormat = getOutputFormat(listCommand);

        try {
          const client = makeClient(process.cwd());
          const result = await client.providerList(providerName);
          emit(result, outputFormat, (data) => formatProviderList(data as ListResult));
        } catch (error) {
          emitError(error, outputFormat);
        }
      });

    const coralCommand = provider.command('coral');
    coralCommand
      .description('Run a prompt through a named Coral agent (e.g. architect, critic)')
      .argument('<agent>', 'Agent name')
      .requiredOption('--prompt <text>', 'Prompt text')
      .option('--session <id>', 'Optional session ID')
      .option('--work-dir <path>', 'Working directory')
      .option('--owner <id>', 'Session owner ID for memo isolation')
      .option('-d, --detach', 'Return launch decision without waiting')
      .action(async (agent: string, opts: ProviderCoralOptions) => {
        const outputFormat = getOutputFormat(coralCommand);

        try {
          const client = makeClient(process.cwd());
          const result = await client.providerCoralDispatch(providerName, agent, opts.prompt, {
            session: opts.session,
            work_dir: opts.workDir,
            owner: opts.owner,
          });
          await handleLaunchResult(result, opts.detach, outputFormat, client);
        } catch (error) {
          emitError(error, outputFormat);
        }
      });
  }
}

export function buildProgram(): Command {
  const program = new Command();

  program
    .name('coral-cli')
    .version(typeof __VERSION__ === 'string' ? __VERSION__ : '0.0.0')
    .description('Coral CLI — invoke providers, monitor jobs, and manage discuss sessions');
  program.addOption(
    new Option('--output-format <format>', 'Output format')
      .choices(['text', 'json'])
      .default('text'),
  );

  registerProviderCommands(program);

  const waitCommand = program.command('wait');
  waitCommand
    .description('Stream job progress (NDJSON output)')
    .requiredOption('--jobs <ids>', 'Comma-separated job IDs')
    .option('--timeout <seconds>', 'Timeout in seconds', '600')
    .option('--cursor <cursor>', 'Opaque resume cursor (from previous wait output)')
    .option('--embed', 'Embed terminal result content when size permits (path is always present)')
    .action(async (opts: WaitOptions) => {
      const outputFormat = getOutputFormat(waitCommand);

      try {
        const jobIds = parseJobIds(opts.jobs);
        const timeoutSeconds = parseIntegerFlag('--timeout', opts.timeout);
        const projectRoot = process.cwd();
        const embed = opts.embed === true;
        const { port, host, token } = await ensureBackend(pluginRoot || undefined);
        const cursorRef: WaitCursorRef = { lastEventId: opts.cursor };

        for await (const event of streamWait(
          jobIds,
          timeoutSeconds,
          { port, host, token },
          opts.cursor,
          undefined,
          projectRoot,
          cursorRef,
        )) {
          const cursor = cursorRef.lastEventId ?? null;

          if (outputFormat === 'json') {
            const record = shapeWaitOutputRecord(event, cursor, embed);
            process.stdout.write(JSON.stringify(record) + '\n');
            continue;
          }

          const ctx: WaitRenderContext = getTerminalContext();
          let formatted: string;

          switch (event.type) {
            case 'progress':
              formatted = formatWaitProgress(event, cursor);
              break;
            case 'queued':
              formatted = formatWaitQueued(event, cursor);
              break;
            case 'terminal':
              formatted = formatWaitTerminal(event, cursor, embed);
              break;
            case 'timeout':
              formatted = formatWaitTimeout(event, cursor);
              break;
          }

          process.stdout.write(renderWaitLine(formatted, ctx));
          if ((event.type === 'terminal' || event.type === 'timeout') && ctx.isTTY) {
            process.stdout.write('\n');
          }
        }
      } catch (error) {
        emitError(error, outputFormat);
      }
    });

  const abortCommand = program.command('abort');
  abortCommand
    .description('Abort running jobs')
    .requiredOption('--jobs <ids>', 'Comma-separated job IDs')
    .action(async (opts: AbortOptions) => {
      const outputFormat = getOutputFormat(abortCommand);

      try {
        const client = makeClient(process.cwd());
        const result = await client.abortJobs(parseJobIds(opts.jobs));
        emit(result, outputFormat, (data) => formatAbortResult(data as AbortResult));
      } catch (error) {
        emitError(error, outputFormat);
      }
    });

  const workflowCommand = program.command('workflow');
  workflowCommand
    .description('Execute a workflow pipeline')
    .option('--expression <expr>', 'Pipeline DSL expression')
    .option('--init-prompt <text>', 'Initial prompt')
    .option('--context <text>', 'Shared context')
    .option('--provider <name>', 'Provider name (registered provider)')
    .option('--work-dir <path>', 'Working directory')
    .option('--stale-timeout-seconds <seconds>', 'Stale job timeout')
    .option('--input-json <source>', 'JSON payload from stdin (use -)')
    .option('--atoms <json>', 'Atoms JSON object (replaces atoms from stdin)')
    .option('--owner <id>', 'Session owner ID for memo isolation')
    .option('-d, --detach', 'Return launch decision without waiting')
    .action(async (opts: WorkflowOptions) => {
      const outputFormat = getOutputFormat(workflowCommand);

      try {
        const base: JsonObject = await parseInputJson(opts.inputJson);
        const {
          expression: baseExpression,
          init_prompt: baseInitPrompt,
          ...basePayload
        } = base;
        const expression = opts.expression ?? (typeof baseExpression === 'string' ? baseExpression : undefined);
        const initPrompt = opts.initPrompt ?? (typeof baseInitPrompt === 'string' ? baseInitPrompt : undefined);

        if (!expression) {
          throw new Error('--expression is required');
        }
        if (!initPrompt) {
          throw new Error('--init-prompt is required');
        }

        const payload = {
          ...basePayload,
          ...(opts.context !== undefined ? { context: opts.context } : {}),
          ...(opts.provider !== undefined ? { provider: opts.provider } : {}),
          ...(opts.workDir !== undefined ? { work_dir: opts.workDir } : {}),
          ...(opts.staleTimeoutSeconds !== undefined
            ? { stale_timeout_seconds: parseIntegerFlag('--stale-timeout-seconds', opts.staleTimeoutSeconds) }
            : {}),
          ...(opts.atoms !== undefined ? { atoms: JSON.parse(opts.atoms) } : {}),
          ...(opts.owner !== undefined ? { owner: opts.owner } : {}),
          init_prompt: initPrompt,
        };

        const client = makeClient(process.cwd());
        const result = await client.workflow(expression, payload);
        await handleLaunchResult(result, opts.detach, outputFormat, client);
      } catch (error) {
        emitError(error, outputFormat);
      }
    });

  const backend = program.command('backend').description('Backend daemon control');

  const backendStatusCommand = backend.command('status');
  backendStatusCommand
    .description('Show backend daemon status')
    .action(async () => {
      const outputFormat = getOutputFormat(backendStatusCommand);

      try {
        const status = await getBackendStatusFull(pluginRoot);
        process.stdout.write(
          (outputFormat === 'text' ? formatBackendStatus(status) : JSON.stringify(status)) + '\n',
        );
      } catch (error) {
        emitError(error, outputFormat);
      }
    });

  const backendShutdownCommand = backend.command('shutdown');
  backendShutdownCommand
    .description('Gracefully shut down backend daemon')
    .action(async () => {
      const outputFormat = getOutputFormat(backendShutdownCommand);

      try {
        const result = await shutdownBackend(pluginRoot);
        const text = outputFormat === 'text' ? formatShutdown(result) : JSON.stringify(result);

        if (result.ok) {
          process.stdout.write(text + '\n');
          return;
        }

        process.stderr.write(text + '\n');
        process.exitCode = 1;
      } catch (error) {
        emitError(error, outputFormat);
      }
    });

  const discuss = program.command('discuss').description('Discussion operations');

  const discussSeedCommand = discuss.command('seed');
  discussSeedCommand
    .description('Generate discussion personas')
    .option('--input-json <source>', 'JSON payload from stdin (use -)')
    .option('--axis <spec>', 'Controversy axis spec (repeatable)', (value: string, previous: string[] | undefined) => [...(previous ?? []), value])
    .option('--count <n>', 'Number of personas')
    .option('--seed <n>', 'Random seed')
    .action(async (opts: DiscussSeedOptions) => {
      const outputFormat = getOutputFormat(discussSeedCommand);

      try {
        const stdinBase: JsonObject = await parseInputJson(opts.inputJson);
        const axes = opts.axis?.map(parseAxisSpec);
        const args = {
          ...stdinBase,
          ...(opts.count !== undefined ? { n: parseIntegerFlag('--count', opts.count) } : {}),
          ...(opts.seed !== undefined ? { seed: parseIntegerFlag('--seed', opts.seed) } : {}),
          ...(axes !== undefined ? { controversy_axes: axes } : {}),
        };
        discussSeedSchema.parse(args);
        const client = makeClient(process.cwd());
        const result = await client.discussSeed(
          args as Parameters<BackendClient['discussSeed']>[0],
        );
        emit(result, outputFormat, (data) => formatPersonaSeed(data as PersonaSeedOutput));
      } catch (error) {
        emitError(error, outputFormat);
      }
    });

  const discussStartCommand = discuss.command('start');
  discussStartCommand
    .description('Start a discussion session')
    .option('--input-json <source>', 'JSON payload from stdin (use -)')
    .option('--agent <spec>', 'Agent spec (repeatable)', (value: string, previous: string[] | undefined) => [...(previous ?? []), value])
    .option('--topic <text>', 'Discussion topic')
    .action(async (opts: DiscussStartOptions) => {
      const outputFormat = getOutputFormat(discussStartCommand);

      try {
        const stdinBase: JsonObject = await parseInputJson(opts.inputJson);
        const agents = opts.agent?.map(parseAgentSpec);
        const args = {
          ...stdinBase,
          ...(opts.topic !== undefined ? { topic: opts.topic } : {}),
          ...(agents !== undefined ? { agents } : {}),
        };
        discussStartSchema.parse(args);
        const client = makeClient(process.cwd());
        const result = await client.discussStart(
          args as Parameters<BackendClient['discussStart']>[0],
        );
        emit(result, outputFormat, (data) => formatDiscussStart(data as DiscussStartResult));
      } catch (error) {
        emitError(error, outputFormat);
      }
    });

  const discussWatchCommand = discuss.command('watch');
  discussWatchCommand
    .description('Fetch discussion events since cursor (returns new events; increment cursor for next call)')
    .requiredOption('--session <id>', 'Session ID')
    .option('--cursor <seq>', 'Resume from sequence number (integer event offset)')
    .action(async (opts: DiscussWatchOptions) => {
      const outputFormat = getOutputFormat(discussWatchCommand);

      try {
        const cursor = opts.cursor !== undefined ? parseIntegerFlag('--cursor', opts.cursor) : undefined;
        const client = makeClient(process.cwd());
        const result = await client.discussWatch(opts.session, cursor);
        emit(result, outputFormat, formatDiscussWatch);
      } catch (error) {
        emitError(error, outputFormat);
      }
    });

  const discussParticipateCommand = discuss.command('participate');
  discussParticipateCommand
    .description('Submit bid or speech')
    .option('--input-json <source>', 'JSON payload from stdin (use -)')
    .option('--session <id>', 'Session ID')
    .option('--agent-name <name>', 'Agent name')
    .option('--score <n>', 'Bid score (0-100)')
    .option('--thought <text>', 'Bid thought')
    .option('--content <text>', 'Speech content')
    .action(async (opts: DiscussParticipateOptions) => {
      const outputFormat = getOutputFormat(discussParticipateCommand);

      try {
        const stdinBase: JsonObject = await parseInputJson(opts.inputJson);
        const args = {
          ...stdinBase,
          ...(opts.session !== undefined ? { session: opts.session } : {}),
          ...(opts.agentName !== undefined ? { agent_name: opts.agentName } : {}),
          ...(opts.score !== undefined ? { score: parseIntegerFlag('--score', opts.score) } : {}),
          ...(opts.thought !== undefined ? { thought: opts.thought } : {}),
          ...(opts.content !== undefined ? { content: opts.content } : {}),
        };
        discussParticipateSchema.parse(args);
        const client = makeClient(process.cwd());
        const result = await client.discussParticipate(
          args as Parameters<BackendClient['discussParticipate']>[0],
        );
        emit(result, outputFormat, (data) => formatDiscussParticipate(data as BidResult | SpeechResult));
      } catch (error) {
        emitError(error, outputFormat);
      }
    });

  const discussAbortCommand = discuss.command('abort');
  discussAbortCommand
    .description('Abort a discussion session')
    .requiredOption('--session <id>', 'Session ID')
    .action(async (opts: DiscussAbortOptions) => {
      const outputFormat = getOutputFormat(discussAbortCommand);

      try {
        const client = makeClient(process.cwd());
        const result = await client.discussAbort(opts.session);
        emit(result, outputFormat, (data) => formatDiscussAbort(data as DiscussAbortResult));
      } catch (error) {
        emitError(error, outputFormat);
      }
    });

  const cliPrefix = getCliDisplayPrefix();
  const kb = program.command('kb').description('Knowledge base operations');

  const kbSearchCommand = kb.command('search');
  kbSearchCommand
    .description('Search KB notes')
    .argument('<query>', 'Search query')
    .option('--top-k <n>', 'Maximum results')
    .action(async (query: string, opts: KbSearchOptions) => {
      const outputFormat = getOutputFormat(kbSearchCommand);

      try {
        const args = {
          query,
          ...(opts.topK !== undefined ? { top_k: parseIntegerFlag('--top-k', opts.topK) } : {}),
        };
        const client = makeClient(process.cwd());
        const result = await client.kbSearch(args);
        emit(result, outputFormat, (data) => formatKbSearch(data, cliPrefix));
      } catch (error) {
        emitError(error, outputFormat);
      }
    });

  const kbPrinciplesCommand = kb.command('principles');
  kbPrinciplesCommand
    .description('List KB principles')
    .option('--query <text>', 'Filter principle names')
    .option('--top-k <n>', 'Maximum results')
    .option('--verbose', 'Include canonical statements and referring note slugs')
    .action(async (opts: KbPrinciplesOptions) => {
      const outputFormat = getOutputFormat(kbPrinciplesCommand);

      try {
        const args = {
          ...(opts.query !== undefined ? { query: opts.query } : {}),
          ...(opts.topK !== undefined ? { top_k: parseIntegerFlag('--top-k', opts.topK) } : {}),
          ...(opts.verbose === true ? { verbose: true } : {}),
        };
        const client = makeClient(process.cwd());
        const result = await client.kbPrinciples(args);
        emit(result, outputFormat, (data) => formatKbPrinciples(data, cliPrefix));
      } catch (error) {
        emitError(error, outputFormat);
      }
    });

  const kbMemoCommand = kb.command('memo')
    .description('Manage project memos');

  const kbMemoWriteCommand = kbMemoCommand.command('write');
  kbMemoWriteCommand
    .description('Write a memo with auto-generated timestamp and frontmatter')
    .requiredOption('--topic <slug>', 'Kebab-case topic slug (e.g. orama-threshold)')
    .option('--content <text>', 'Memo body text')
    .option('--content-file <path>', 'Read memo body from file')
    .option('--owner <id>', 'Session owner ID (falls back to CORAL_OWNER env var)')
    .action(async (opts: { topic: string; content?: string; contentFile?: string; owner?: string }) => {
      const outputFormat = getOutputFormat(kbMemoWriteCommand);

      try {
        const content = opts.contentFile !== undefined
          ? readFileSync(resolveFilePath(opts.contentFile), 'utf8')
          : opts.content;
        if (content === undefined) {
          throw new Error('Either --content or --content-file is required');
        }
        const rawOwner = opts.owner ?? process.env.CORAL_OWNER;
        if (!rawOwner) {
          throw new Error('--owner is required (or set CORAL_OWNER env var)');
        }
        const owner = assertOwnerId(rawOwner, 'owner');
        const client = makeClient(process.cwd());
        const result = await client.kbMemo({ topic: opts.topic, content, owner });
        emit(result, outputFormat, formatKbMemo);
      } catch (error) {
        emitError(error, outputFormat);
      }
    });

  const kbMemoListCommand = kbMemoCommand.command('list');
  kbMemoListCommand
    .description('List project memos')
    .option('--owner <id>', 'Filter by owner session ID')
    .action(async (opts: { owner?: string }) => {
      const outputFormat = getOutputFormat(kbMemoListCommand);

      try {
        const client = makeClient(process.cwd());
        const result = await client.kbMemoList({ owner: opts.owner });
        emit(result, outputFormat, formatKbMemoList);
      } catch (error) {
        emitError(error, outputFormat);
      }
    });

  const kbMemoDeleteCommand = kbMemoCommand.command('delete');
  kbMemoDeleteCommand
    .description('Delete project memos by simple glob pattern')
    .argument('<pattern>', 'Simple glob pattern (supports * and ?)')
    .option('--owner <id>', 'Only delete memos owned by this session ID')
    .action(async (pattern: string, opts: { owner?: string }) => {
      const outputFormat = getOutputFormat(kbMemoDeleteCommand);

      try {
        const client = makeClient(process.cwd());
        const result = await client.kbMemoDelete({ pattern, owner: opts.owner });
        emit(result, outputFormat, formatKbMemoDelete);
      } catch (error) {
        emitError(error, outputFormat);
      }
    });

  const kbMemoPurgeCommand = kbMemoCommand.command('purge');
  kbMemoPurgeCommand
    .description('Delete all project memos')
    .option('--owner <owner>', 'Only purge memos owned by this session')
    .action(async (opts: { owner?: string }) => {
      const outputFormat = getOutputFormat(kbMemoPurgeCommand);

      try {
        const client = makeClient(process.cwd());
        const result = await client.kbMemoPurge(opts.owner ? { owner: opts.owner } : {});
        emit(result, outputFormat, formatKbMemoPurge);
      } catch (error) {
        emitError(error, outputFormat);
      }
    });

  const kbReadCommand = kb.command('read');
  kbReadCommand
    .description('Read a KB entry by slug')
    .argument('<note>', 'Note or principle slug without extension (e.g. rendering-guiding-contracts)')
    .action(async (note: string) => {
      const outputFormat = getOutputFormat(kbReadCommand);

      try {
        const client = makeClient(process.cwd());
        const result = await client.kbRead({ note });
        emit(result, outputFormat, formatKbRead);
      } catch (error) {
        emitError(error, outputFormat);
      }
    });

  const kbPromoteCommand = kb.command('promote');
  kbPromoteCommand
    .description('Promote a memo into a KB note')
    .option('--memo <filename>', 'Memo filename (e.g. 20260325-topic.md)')
    .option('--title <text>', 'Note title')
    .option('--content-file <path>', 'Read content from file')
    .option('--domain <slug>', 'Note domain')
    .option('--topic <slug>', 'Note topic')
    .action(async (opts: KbPromoteOptions) => {
      const outputFormat = getOutputFormat(kbPromoteCommand);

      try {
        const content = opts.contentFile !== undefined
          ? readFileSync(resolveFilePath(opts.contentFile), 'utf8')
          : undefined;
        const args = {
          ...(opts.memo !== undefined ? { memo: opts.memo } : {}),
          ...(opts.title !== undefined ? { title: opts.title } : {}),
          ...(content !== undefined ? { content } : {}),
          ...(opts.domain !== undefined ? { domain: opts.domain } : {}),
          ...(opts.topic !== undefined ? { topic: opts.topic } : {}),
        };
        const client = makeClient(process.cwd());
        const result = await client.kbPromote(
          args as Parameters<BackendClient['kbPromote']>[0],
        );
        emit(result, outputFormat, formatKbPromote);
      } catch (error) {
        emitError(error, outputFormat);
      }
    });

  const kbUpdateCommand = kb.command('update');
  kbUpdateCommand
    .description('Update an existing KB note')
    .argument('<note>', 'Note slug without extension (e.g. rendering-guiding-contracts)')
    .option('--title <text>', 'Updated title')
    .option('--content-file <path>', 'Read content from file')
    .action(async (note: string, opts: KbUpdateOptions) => {
      const outputFormat = getOutputFormat(kbUpdateCommand);

      try {
        const args = {
          note,
          ...(opts.title !== undefined ? { title: opts.title } : {}),
          ...(opts.contentFile !== undefined ? { content: readFileSync(resolveFilePath(opts.contentFile), 'utf8') } : {}),
        };
        const client = makeClient(process.cwd());
        const result = await client.kbUpdate(args);
        emit(result, outputFormat, formatKbUpdate);
      } catch (error) {
        emitError(error, outputFormat);
      }
    });

  const kbDeleteCommand = kb.command('delete');
  kbDeleteCommand
    .description('Delete a KB note')
    .argument('<note>', 'Note slug without extension (e.g. rendering-guiding-contracts)')
    .action(async (note: string) => {
      const outputFormat = getOutputFormat(kbDeleteCommand);

      try {
        const client = makeClient(process.cwd());
        const result = await client.kbDelete({ note });
        emit(result, outputFormat, formatKbDelete);
      } catch (error) {
        emitError(error, outputFormat);
      }
    });

  const kbReindexCommand = kb.command('reindex');
  kbReindexCommand
    .description('Rebuild the KB index')
    .action(async () => {
      const outputFormat = getOutputFormat(kbReindexCommand);

      try {
        const client = makeClient(process.cwd());
        const result = await client.kbReindex({});
        emit(result, outputFormat, (data) => formatKbReindex(data, cliPrefix));
      } catch (error) {
        emitError(error, outputFormat);
      }
    });

  return program;
}
