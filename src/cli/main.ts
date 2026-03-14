declare const __PLUGIN_ROOT__: string;
declare const __VERSION__: string;

import { readFileSync } from 'node:fs';
import { Command, Option } from 'commander';

import {
  BackendClient,
  BackendToolHttpError,
  type CallerContext,
} from '../client/http-client.js';
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
import type { LaunchDecision, WaitStreamEvent } from '../types.js';
import {
  type DiscussAbortResult,
  type DiscussStartResult,
  formatAbortResult,
  formatBackendStatus,
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
import {
  isJsonObject,
  parseAgentSpec,
  parseAxisSpec,
  parseInputJson,
  type JsonObject,
} from './parse.js';

const providerNames: readonly string[] = ['codex', 'claude'];
const pluginRoot = typeof __PLUGIN_ROOT__ === 'string' ? __PLUGIN_ROOT__ : (process.env.CLAUDE_PLUGIN_ROOT ?? '');

type ProviderExecOptions = {
  prompt: string;
  session?: string;
  workDir?: string;
  model?: string;
  systemPrompt?: string;
  bypassPermissions?: boolean;
};

type ProviderForkOptions = {
  session: string;
  prompt?: string;
  workDir?: string;
  model?: string;
};

type ProviderCoralOptions = {
  prompt: string;
  session?: string;
  workDir?: string;
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

function makeClient(projectRoot: string): BackendClient {
  const defaultContext: CallerContext = { pluginRoot, projectRoot };
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

function isTextOutput(): boolean {
  return program.opts<{ outputFormat?: string }>().outputFormat !== 'json';
}

function emit(result: unknown, textFormatter?: (data: unknown) => string): void {
  const { output, isError } = normalizeResult(result);
  const isText = isTextOutput();

  if (isError) {
    const text = isText ? formatError(output) : JSON.stringify(output);
    process.stderr.write(text + '\n');
    process.exitCode = 1;
    return;
  }

  const text = isText && textFormatter !== undefined
    ? textFormatter(output)
    : JSON.stringify(output);
  process.stdout.write(text + '\n');
}

function emitError(error: unknown): void {
  const isText = isTextOutput();

  if (isText) {
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

function normalizeProviderArgv(argv: readonly string[]): string[] {
  if (argv.length < 4) {
    return argv.slice();
  }

  const [nodePath, scriptPath, provider, dispatchToken] = argv;

  if (!providerNames.includes(provider)) {
    return argv.slice();
  }

  const match = /^coral:([a-z0-9][a-z0-9-]*)$/.exec(dispatchToken);
  if (!match) {
    return argv.slice();
  }

  return [nodePath, scriptPath, provider, 'coral', match[1], ...argv.slice(4)];
}

function registerProviderCommands(program: Command): void {
  for (const providerName of providerNames) {
    const provider = program
      .command(providerName)
      .description(`${providerName} provider operations`);

    provider.command('exec')
      .description('Execute a prompt')
      .requiredOption('--prompt <text>', 'Prompt text')
      .option('--session <id>', 'Resume session ID')
      .option('--work-dir <path>', 'Working directory')
      .option('--model <model>', 'Model override')
      .option('--system-prompt <text>', 'System prompt override')
      .option('--bypass-permissions', 'Bypass permission checks')
      .action(async (opts: ProviderExecOptions) => {
        try {
          const client = makeClient(process.cwd());
          const result = await client.providerExec(providerName, opts.prompt, {
            session: opts.session,
            work_dir: opts.workDir,
            model: opts.model,
            system_prompt: opts.systemPrompt,
            bypass_permissions: opts.bypassPermissions,
          });
          emit(result, (data) => formatLaunchDecision(data as LaunchDecision));
        } catch (error) {
          emitError(error);
        }
      });

    provider.command('fork')
      .description('Branch from an existing session, optionally continuing with a new prompt')
      .requiredOption('--session <id>', 'Source session ID')
      .option('--prompt <text>', 'Follow-up prompt')
      .option('--work-dir <path>', 'Working directory')
      .option('--model <model>', 'Model override')
      .action(async (opts: ProviderForkOptions) => {
        try {
          const client = makeClient(process.cwd());
          const result = await client.providerFork(providerName, opts.session, opts.prompt, {
            work_dir: opts.workDir,
            model: opts.model,
          });
          emit(result, (data) => formatLaunchDecision(data as LaunchDecision));
        } catch (error) {
          emitError(error);
        }
      });

    provider.command('list')
      .description('List sessions')
      .action(async () => {
        try {
          const client = makeClient(process.cwd());
          const result = await client.providerList(providerName);
          emit(result, (data) => formatProviderList(data as ListResult));
        } catch (error) {
          emitError(error);
        }
      });

    provider.command('coral')
      .description('Run a prompt through a named Coral agent (e.g. architect, critic)')
      .argument('<agent>', 'Agent name')
      .requiredOption('--prompt <text>', 'Prompt text')
      .option('--session <id>', 'Optional session ID')
      .option('--work-dir <path>', 'Working directory')
      .action(async (agent: string, opts: ProviderCoralOptions) => {
        try {
          const client = makeClient(process.cwd());
          const result = await client.providerCoralDispatch(providerName, agent, opts.prompt, {
            session: opts.session,
            work_dir: opts.workDir,
          });
          emit(result, (data) => formatLaunchDecision(data as LaunchDecision));
        } catch (error) {
          emitError(error);
        }
      });
  }
}

const program = new Command();

program
  .name('coral-cli')
  .version(typeof __VERSION__ === 'string' ? __VERSION__ : '0.0.0')
  .description('Coral CLI — invoke Codex/Claude providers, monitor jobs, and manage discuss sessions');
program.addOption(
  new Option('--output-format <format>', 'Output format')
    .choices(['text', 'json'])
    .default('text'),
);

registerProviderCommands(program);

program.command('wait')
  .description('Stream job progress (NDJSON output)')
  .requiredOption('--jobs <ids>', 'Comma-separated job IDs')
  .option('--timeout <seconds>', 'Timeout in seconds', '600')
  .option('--cursor <cursor>', 'Opaque resume cursor (from previous wait output)')
  .option('--embed', 'Embed terminal result content when size permits (path is always present)')
  .action(async (opts: WaitOptions) => {
    try {
      const jobIds = parseJobIds(opts.jobs);
      const timeoutSeconds = parseIntegerFlag('--timeout', opts.timeout);
      const projectRoot = process.cwd();
      const isText = isTextOutput();
      const embed = opts.embed === true;
      // Use streamWait directly (not BackendClient.wait) — the CLI cursor is a raw SSE id
      // string, while BackendClient.wait uses a different base64url-encoded WaitCursor type.
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

        if (!isText) {
          const record = shapeWaitOutputRecord(event, cursor, embed);
          process.stdout.write(JSON.stringify(record) + '\n');
          continue;
        }

        const ctx: WaitRenderContext = {
          isTTY: process.stdout.isTTY === true,
          columns: process.stdout.columns ?? 80,
        };
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
      emitError(error);
    }
  });

program.command('abort')
  .description('Abort running jobs')
  .requiredOption('--jobs <ids>', 'Comma-separated job IDs')
  .action(async (opts: AbortOptions) => {
    try {
      const client = makeClient(process.cwd());
      const result = await client.abortJobs(parseJobIds(opts.jobs));
      emit(result, (data) => formatAbortResult(data as AbortResult));
    } catch (error) {
      emitError(error);
    }
  });

program.command('workflow')
  .description('Execute a workflow pipeline')
  .option('--expression <expr>', 'Pipeline DSL expression')
  .option('--init-prompt <text>', 'Initial prompt')
  .option('--context <text>', 'Shared context')
  .option('--provider <name>', 'Provider (claude or codex)')
  .option('--work-dir <path>', 'Working directory')
  .option('--stale-timeout-seconds <seconds>', 'Stale job timeout')
  .option('--input-json <source>', 'JSON payload from stdin (use -)')
  .option('--atoms <json>', 'Atoms JSON object (replaces atoms from stdin)')
  .action(async (opts: WorkflowOptions) => {
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
        init_prompt: initPrompt,
      };

      const client = makeClient(process.cwd());
      const result = await client.workflow(expression, payload);
      emit(result, (data) => formatLaunchDecision(data as LaunchDecision));
    } catch (error) {
      emitError(error);
    }
  });

const backend = program.command('backend').description('Backend daemon control');

backend.command('status')
  .description('Show backend daemon status')
  .action(async () => {
    try {
      const status = await getBackendStatusFull(pluginRoot);
      const isText = isTextOutput();
      process.stdout.write((isText ? formatBackendStatus(status) : JSON.stringify(status)) + '\n');
    } catch (error) {
      emitError(error);
    }
  });

backend.command('shutdown')
  .description('Gracefully shut down backend daemon')
  .action(async () => {
    try {
      const result = await shutdownBackend(pluginRoot);
      const isText = isTextOutput();
      if (result.ok) {
        process.stdout.write((isText ? formatShutdown(result) : JSON.stringify(result)) + '\n');
        return;
      }

      process.stderr.write((isText ? formatShutdown(result) : JSON.stringify(result)) + '\n');
      process.exitCode = 1;
    } catch (error) {
      emitError(error);
    }
  });

const discuss = program.command('discuss').description('Discussion operations');

discuss.command('seed')
  .description('Generate discussion personas')
  .option('--input-json <source>', 'JSON payload from stdin (use -)')
  .option('--axis <spec>', 'Controversy axis spec (repeatable)', (value: string, previous: string[] | undefined) => [...(previous ?? []), value])
  .option('--count <n>', 'Number of personas')
  .option('--seed <n>', 'Random seed')
  .action(async (opts: DiscussSeedOptions) => {
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
      emit(result, (data) => formatPersonaSeed(data as PersonaSeedOutput));
    } catch (error) {
      emitError(error);
    }
  });

discuss.command('start')
  .description('Start a discussion session')
  .option('--input-json <source>', 'JSON payload from stdin (use -)')
  .option('--agent <spec>', 'Agent spec (repeatable)', (value: string, previous: string[] | undefined) => [...(previous ?? []), value])
  .option('--topic <text>', 'Discussion topic')
  .action(async (opts: DiscussStartOptions) => {
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
      emit(result, (data) => formatDiscussStart(data as DiscussStartResult));
    } catch (error) {
      emitError(error);
    }
  });

discuss.command('watch')
  .description('Fetch discussion events since cursor (returns new events; increment cursor for next call)')
  .requiredOption('--session <id>', 'Session ID')
  .option('--cursor <seq>', 'Resume from sequence number (integer event offset)')
  .action(async (opts: DiscussWatchOptions) => {
    try {
      const cursor = opts.cursor !== undefined ? parseIntegerFlag('--cursor', opts.cursor) : undefined;
      const client = makeClient(process.cwd());
      const result = await client.discussWatch(opts.session, cursor);
      emit(result, formatDiscussWatch);
    } catch (error) {
      emitError(error);
    }
  });

discuss.command('participate')
  .description('Submit bid or speech')
  .option('--input-json <source>', 'JSON payload from stdin (use -)')
  .option('--session <id>', 'Session ID')
  .option('--agent-name <name>', 'Agent name')
  .option('--score <n>', 'Bid score (0-100)')
  .option('--thought <text>', 'Bid thought')
  .option('--content <text>', 'Speech content')
  .action(async (opts: DiscussParticipateOptions) => {
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
      emit(result, (data) => formatDiscussParticipate(data as BidResult | SpeechResult));
    } catch (error) {
      emitError(error);
    }
  });

discuss.command('abort')
  .description('Abort a discussion session')
  .requiredOption('--session <id>', 'Session ID')
  .action(async (opts: DiscussAbortOptions) => {
    try {
      const client = makeClient(process.cwd());
      const result = await client.discussAbort(opts.session);
      emit(result, (data) => formatDiscussAbort(data as DiscussAbortResult));
    } catch (error) {
      emitError(error);
    }
  });

program.parseAsync(normalizeProviderArgv(process.argv)).catch((error) => {
  emitError(error);
  process.exit(1);
});
