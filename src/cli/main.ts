declare const __PLUGIN_ROOT__: string;
declare const __VERSION__: string;

import { existsSync, readFileSync } from 'node:fs';
import { Command, Option } from 'commander';

import {
  BackendClient,
  BackendToolHttpError,
  type AcceptedLaunchResponse,
  type CallerContext,
} from '../client/http-client.js';
import { getBackendStatusFull, shutdownBackend, streamWait, type WaitCursorRef } from '../client/backend-helpers.js';
import { assertOwnerId, collectCoralEnv } from '../shared/utils.js';
import { ensureBackend } from '../client/backend-lifecycle.js';
import { discussBidSchema, discussSeedSchema, discussSpeechSchema, discussStartSchema } from '../discuss/schemas.js';
import { MAX_INLINE } from '../shared/schemas.js';
import type { WaitStreamEvent } from '../shared/types.js';
import {
  type SessionListResult,
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
  formatKbSourceDelete,
  formatKbSourceImport,
  formatKbSourceList,
  formatKbUpdate,
  formatDiscussAbort,
  formatDiscussParticipate,
  formatDiscussStart,
  formatDiscussWatch,
  formatError,
  formatLaunch,
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
import { isJsonObject, parseAgentSpec, parseAxisSpec, parseInputJson, type JsonObject } from './parse.js';
import { createBuiltInProviderRegistry } from '../providers/bootstrap.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { prepareSourceImport } from '../kb/ops/source-import.js';
import { assertSourceSlug } from '../kb/validation.js';

function getProviderNames(providerRegistry: ProviderRegistry): string[] {
  return providerRegistry.getAll().map((provider) => provider.name);
}

const pluginRoot = typeof __PLUGIN_ROOT__ === 'string' ? __PLUGIN_ROOT__ : (process.env.CLAUDE_PLUGIN_ROOT ?? '');

type ProviderRunOptions = {
  input?: string[];
  session?: string;
  workDir?: string;
  model?: string;
  owner?: string;
  bypassPermissions?: boolean;
  detach?: boolean;
};

type ProviderListOptions = {
  provider?: string;
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
  startPrompt?: string[];
  context?: string[];
  provider?: string;
  workDir?: string;
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
  scope?: 'notes' | 'communities' | 'sources' | 'all';
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

type KbSourceImportOptions = {
  slug?: string;
};

function resolveFilePath(filePath: string): string {
  if (existsSync(filePath)) return filePath;
  if (!filePath.endsWith('.md')) {
    const withMd = `${filePath}.md`;
    if (existsSync(withMd)) return withMd;
  }
  return filePath;
}

function resolveInput(values: string[]): string {
  // Each token is resolved independently: existing files are read, other tokens stay literal.
  // Multi-value inputs are joined with spaces, which recovers prompts that a shell split into
  // multiple argv entries (e.g. unquoted `-i hello world`) and prompts that the cli-resolve
  // hook partially materialized into a temp file alongside adjacent literal tokens.
  return values
    .map((token) => (existsSync(token) ? readFileSync(token, 'utf8') : token))
    .join(' ');
}

function makeClient(projectRoot: string): BackendClient {
  const defaultContext: CallerContext = { pluginRoot, projectRoot, coralEnv: collectCoralEnv() };
  return new BackendClient({
    ensureBackend: () => ensureBackend(pluginRoot || undefined),
    defaultContext,
  });
}

export function getOutputFormat(command: Command): 'text' | 'json' {
  return command.optsWithGlobals<{ outputFormat?: string }>().outputFormat === 'json' ? 'json' : 'text';
}

function getCliDisplayPrefix(argv: readonly string[] = process.argv): string {
  return argv[0]?.match(/node(\.exe)?$/) ? `node "${argv[1]}"` : (argv[0] ?? 'coral-cli');
}

function emit<T>(result: T, outputFormat: 'text' | 'json', textFormatter?: (data: T) => string): void {
  const text = outputFormat === 'text' && textFormatter !== undefined ? textFormatter(result) : JSON.stringify(result);
  process.stdout.write(text + '\n');
}

export function emitError(error: unknown, outputFormat: 'text' | 'json'): void {
  let message: string;

  if (outputFormat === 'text') {
    message = formatError(error);
  } else if (error instanceof BackendToolHttpError) {
    message = JSON.stringify({ error: true, statusCode: error.statusCode, body: error.body });
  } else if (error instanceof Error) {
    message = JSON.stringify({ error: true, message: error.message });
  } else {
    message = JSON.stringify({ error: true, message: String(error) });
  }

  process.stderr.write(message + '\n');
  process.exitCode = 1;
}

function parseIntegerFlag(flagName: string, value: string): number {
  if (!/^-?\d+$/.test(value)) {
    throw new Error(`${flagName} must be an integer`);
  }

  return Number.parseInt(value, 10);
}

function parseJobIds(raw: string): string[] {
  const jobIds = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (jobIds.length === 0) {
    throw new Error('--jobs must include at least one job ID');
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

export function emitAcceptedLaunchResponse(decision: AcceptedLaunchResponse, outputFormat: 'text' | 'json'): void {
  const text = outputFormat === 'text' ? formatLaunch(decision) : JSON.stringify(decision);
  process.stdout.write(text + '\n');
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
  if (!isAcceptedLaunchResponse(result)) {
    emitError(
      new Error(`Expected accepted launch response, received: ${JSON.stringify(result)}`),
      outputFormat,
    );
    return;
  }

  if (detach) {
    emitAcceptedLaunchResponse(result, outputFormat);
    return;
  }

  process.exitCode = await launchAndFollow({
    launchResult: result,
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

function shapeWaitOutputRecord(event: WaitStreamEvent, cursor: string | null, embed: boolean): WaitOutputRecord {
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

  return JSON.stringify(embeddedRecord).length <= MAX_INLINE ? embeddedRecord : pathOnlyRecord;
}

function registerProviderCommands(program: Command, providerRegistry: ProviderRegistry): void {
  for (const providerName of getProviderNames(providerRegistry)) {
    const provider = program.command(providerName).description(`${providerName} provider operations`);
    provider
      .argument('[agent]', 'Agent name (omit for raw execution)')
      .option('-i, --input <text-or-file...>', 'Prompt text or file path (multiple tokens are joined with spaces; a single existing path is read as a file)')
      .option('-s, --session <id>', 'Session ID')
      .option('-w, --work-dir <path>', 'Working directory')
      .option('-m, --model <model>', 'Model override')
      .option('-o, --owner <id>', 'Owner ID for memo isolation')
      .option('-b, --bypass-permissions', 'Bypass permission checks')
      .option('-d, --detach', 'Return launch decision without waiting')
      .action(async (agent: string | undefined, opts: ProviderRunOptions) => {
        const outputFormat = getOutputFormat(provider);

        try {
          if (agent === 'list') {
            throw new Error(
              `Legacy "coral-cli ${providerName} list" has moved to "coral-cli list --provider ${providerName}"`,
            );
          }
          if (opts.input === undefined) {
            throw new Error('input is required (-i, --input)');
          }

          const prompt = resolveInput(opts.input);
          const client = makeClient(process.cwd());
          const requestOptions = {
            ...(opts.workDir !== undefined ? { workDir: opts.workDir } : {}),
            ...(opts.model !== undefined ? { model: opts.model } : {}),
            ...(opts.owner !== undefined ? { owner: opts.owner } : {}),
            ...(opts.bypassPermissions !== undefined ? { bypassPermissions: opts.bypassPermissions } : {}),
          };
          const result = opts.session
            ? await client.sendMessage(opts.session, prompt, requestOptions)
            : await client.createSession(
                providerName,
                prompt,
                agent ? { agent, ...requestOptions } : requestOptions,
              );
          await handleLaunchResult(result, opts.detach, outputFormat, client);
        } catch (error) {
          emitError(error, outputFormat);
        }
      });
  }
}

export function buildProgram(providerRegistry: ProviderRegistry = createBuiltInProviderRegistry()): Command {
  const program = new Command();

  program
    .name('coral-cli')
    .version(typeof __VERSION__ === 'string' ? __VERSION__ : '0.0.0')
    .description('Coral CLI — invoke providers, monitor jobs, and manage discuss sessions');
  program.addOption(
    new Option('-f, --output-format <format>', 'Output format').choices(['text', 'json']).default('text'),
  );

  registerProviderCommands(program, providerRegistry);

  const listCommand = program.command('list');
  listCommand
    .description('List sessions')
    .option('--provider <name>', 'Filter by provider')
    .action(async (opts: ProviderListOptions) => {
      const outputFormat = getOutputFormat(listCommand);

      try {
        const client = makeClient(process.cwd());
        if (opts.provider !== undefined && !getProviderNames(providerRegistry).includes(opts.provider)) {
          throw new Error(`Unknown provider: ${opts.provider}`);
        }

        const result = await client.listSessions();
        const providerFiltered = opts.provider === undefined
          ? result.sessions
          : result.sessions.filter((session) => session.provider === opts.provider);
        const displayResult: SessionListResult = {
          sessions: providerFiltered.map((session) => ({
            provider: session.provider,
            sessionId: session.sessionId,
            state: session.state,
            name: session.name,
            model: session.model,
            cwd: session.cwd,
          })),
        };
        emit(displayResult, outputFormat, (data) =>
          formatProviderList(data, { includeProvider: opts.provider === undefined }),
        );
      } catch (error) {
        emitError(error, outputFormat);
      }
    });

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
        emit(result, outputFormat, formatAbortResult);
      } catch (error) {
        emitError(error, outputFormat);
      }
    });

  const workflowCommand = program.command('workflow');
  workflowCommand
    .description('Execute a workflow pipeline')
    .option('-e, --expression <expr>', 'Pipeline DSL expression')
    .option('-s, --start-prompt <text-or-file...>', 'Start prompt text or file path (multiple tokens are joined with spaces; a single existing path is read as a file)')
    .option('-c, --context <text-or-file...>', 'Shared context text or file path (multiple tokens are joined with spaces; a single existing path is read as a file)')
    .option('-p, --provider <name>', 'Provider name (registered provider)')
    .option('-w, --work-dir <path>', 'Working directory')
    .option('-o, --owner <id>', 'Session owner ID for memo isolation')
    .option('-d, --detach', 'Return launch decision without waiting')
    .action(async (opts: WorkflowOptions) => {
      const outputFormat = getOutputFormat(workflowCommand);

      try {
        const { expression } = opts;

        if (expression === undefined) {
          throw new Error('expression is required (-e, --expression)');
        }
        if (opts.startPrompt === undefined) {
          throw new Error('start prompt is required (-s, --start-prompt)');
        }

        const payload = {
          ...(opts.context !== undefined ? { context: resolveInput(opts.context) } : {}),
          ...(opts.provider !== undefined ? { provider: opts.provider } : {}),
          ...(opts.workDir !== undefined ? { workDir: opts.workDir } : {}),
          ...(opts.owner !== undefined ? { owner: opts.owner } : {}),
          startPrompt: resolveInput(opts.startPrompt),
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
  backendStatusCommand.description('Show backend daemon status').action(async () => {
    const outputFormat = getOutputFormat(backendStatusCommand);

    try {
      const status = await getBackendStatusFull(pluginRoot);
      process.stdout.write((outputFormat === 'text' ? formatBackendStatus(status) : JSON.stringify(status)) + '\n');
    } catch (error) {
      emitError(error, outputFormat);
    }
  });

  const backendShutdownCommand = backend.command('shutdown');
  backendShutdownCommand.description('Gracefully shut down backend daemon').action(async () => {
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
    .option('--axis <spec>', 'Controversy axis spec (repeatable)', (value: string, previous: string[] | undefined) => [
      ...(previous ?? []),
      value,
    ])
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
        const result = await client.discussSeed(args as Parameters<BackendClient['discussSeed']>[0]);
        emit(result, outputFormat, formatPersonaSeed);
      } catch (error) {
        emitError(error, outputFormat);
      }
    });

  const discussStartCommand = discuss.command('start');
  discussStartCommand
    .description('Start a discussion session')
    .option('--input-json <source>', 'JSON payload from stdin (use -)')
    .option('--agent <spec>', 'Agent spec (repeatable)', (value: string, previous: string[] | undefined) => [
      ...(previous ?? []),
      value,
    ])
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
        const result = await client.discussStart(args as Parameters<BackendClient['discussStart']>[0]);
        emit(result, outputFormat, formatDiscussStart);
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
        const isSpeech = 'content' in args;
        if (isSpeech) {
          discussSpeechSchema.parse(args);
        } else {
          discussBidSchema.parse(args);
        }
        const client = makeClient(process.cwd());
        const result = isSpeech
          ? await client.discussSpeech(args as Parameters<BackendClient['discussSpeech']>[0])
          : await client.discussBid(args as Parameters<BackendClient['discussBid']>[0]);
        emit(result, outputFormat, formatDiscussParticipate);
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
        emit(result, outputFormat, formatDiscussAbort);
      } catch (error) {
        emitError(error, outputFormat);
      }
    });

  const cliPrefix = getCliDisplayPrefix();
  const kb = program.command('kb').description('Knowledge base operations');

  const kbSearchCommand = kb.command('search');
  kbSearchCommand
    .description('Search KB entries')
    .argument('<query>', 'Search query')
    .option('--top-k <n>', 'Maximum results')
    .addOption(
      new Option('--scope <scope>', 'Limit results to notes, communities, sources, or all').choices([
        'notes',
        'communities',
        'sources',
        'all',
      ]),
    )
    .action(async (query: string, opts: KbSearchOptions) => {
      const outputFormat = getOutputFormat(kbSearchCommand);

      try {
        const args = {
          query,
          ...(opts.topK !== undefined ? { top_k: parseIntegerFlag('--top-k', opts.topK) } : {}),
          ...(opts.scope !== undefined ? { scope: opts.scope } : {}),
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

  const kbSourceCommand = kb.command('source').description('Manage KB sources');

  const kbSourceImportCommand = kbSourceCommand.command('import');
  kbSourceImportCommand
    .description('Import a source file into the KB')
    .argument('<file>', 'File to import')
    .option('--slug <slug>', 'Override source slug')
    .action(async (file: string, opts: KbSourceImportOptions) => {
      const outputFormat = getOutputFormat(kbSourceImportCommand);

      try {
        const prepared = await prepareSourceImport(resolveFilePath(file), opts.slug, (line) =>
          process.stderr.write(`${line}\n`),
        );
        const client = makeClient(process.cwd());
        const result = await client.kbSourceImport({
          slug: prepared.slug,
          stagedPath: prepared.stagedPath,
          meta: prepared.meta,
        });
        emit(result, outputFormat, formatKbSourceImport);
      } catch (error) {
        emitError(error, outputFormat);
      }
    });

  const kbSourceListCommand = kbSourceCommand.command('list');
  kbSourceListCommand.description('List KB sources').action(async () => {
    const outputFormat = getOutputFormat(kbSourceListCommand);

    try {
      const client = makeClient(process.cwd());
      const result = await client.kbSourceList();
      emit(result, outputFormat, formatKbSourceList);
    } catch (error) {
      emitError(error, outputFormat);
    }
  });

  const kbSourceDeleteCommand = kbSourceCommand.command('delete');
  kbSourceDeleteCommand
    .description('Delete a KB source')
    .argument('<slug>', 'Source slug without extension')
    .action(async (slug: string) => {
      const outputFormat = getOutputFormat(kbSourceDeleteCommand);

      try {
        const client = makeClient(process.cwd());
        const result = await client.kbSourceDelete({ slug: assertSourceSlug(slug, 'source') });
        emit(result, outputFormat, formatKbSourceDelete);
      } catch (error) {
        emitError(error, outputFormat);
      }
    });

  const kbMemoCommand = kb.command('memo').description('Manage project memos');

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
        const content =
          opts.contentFile !== undefined ? readFileSync(resolveFilePath(opts.contentFile), 'utf8') : opts.content;
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
    .description('Read a KB entry by slug or explicit selector')
    .argument(
      '<note>',
      'Bare reads resolve memo -> note -> community -> source -> principle; use communities:<slug> or sources:<slug> to force a kind',
    )
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
        const content =
          opts.contentFile !== undefined ? readFileSync(resolveFilePath(opts.contentFile), 'utf8') : undefined;
        const args = {
          ...(opts.memo !== undefined ? { memo: opts.memo } : {}),
          ...(opts.title !== undefined ? { title: opts.title } : {}),
          ...(content !== undefined ? { content } : {}),
          ...(opts.domain !== undefined ? { domain: opts.domain } : {}),
          ...(opts.topic !== undefined ? { topic: opts.topic } : {}),
        };
        const client = makeClient(process.cwd());
        const result = await client.kbPromote(args as Parameters<BackendClient['kbPromote']>[0]);
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
        const content =
          opts.contentFile !== undefined ? readFileSync(resolveFilePath(opts.contentFile), 'utf8') : undefined;
        const args = {
          note,
          ...(opts.title !== undefined ? { title: opts.title } : {}),
          ...(content !== undefined ? { content } : {}),
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
  kbReindexCommand.description('Rebuild the KB index').action(async () => {
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
