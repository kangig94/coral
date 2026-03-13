declare const __PLUGIN_ROOT__: string;
declare const __VERSION__: string;

import { readFileSync } from 'node:fs';
import { readFile as readFileAsync } from 'node:fs/promises';
import { Command } from 'commander';

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
import type { WaitStreamEvent } from '../types.js';

const providerNames = ['codex', 'claude'] as const;
const providerNameSet = new Set<string>(providerNames);
const pluginRoot = typeof __PLUGIN_ROOT__ === 'string' ? __PLUGIN_ROOT__ : (process.env.CLAUDE_PLUGIN_ROOT ?? '');

type JsonObject = Record<string, unknown>;

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
  inline?: boolean;
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
  json?: string;
};

type DiscussSeedOptions = {
  json: string;
  count?: string;
  seed?: string;
};

type DiscussStartOptions = {
  json: string;
  topic?: string;
};

type DiscussWatchOptions = {
  session: string;
  cursor?: string;
};

type DiscussParticipateOptions = {
  json?: string;
  session: string;
  agentName: string;
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

// Stricter than shared isRecord — excludes arrays because JSON flags must be objects
function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeResult(result: unknown): { output: unknown; isError: boolean } {
  if (
    isRecord(result)
    && typeof result.isError === 'boolean'
    && Array.isArray(result.content)
    && result.content.length > 0
  ) {
    const first = result.content[0];
    if (isRecord(first) && typeof first.text === 'string') {
      try {
        return { output: JSON.parse(first.text), isError: result.isError };
      } catch {
        return { output: first.text, isError: result.isError };
      }
    }
  }

  if (isRecord(result) && result.status === 'rejected') {
    return { output: result, isError: true };
  }

  // Non-MCP response shape — treat as success and emit as-is
  return { output: result, isError: false };
}

function emit(result: unknown): void {
  const { output, isError } = normalizeResult(result);
  const text = JSON.stringify(output);

  if (isError) {
    process.stderr.write(text + '\n');
    process.exitCode = 1;
    return;
  }

  process.stdout.write(text + '\n');
}

function emitError(error: unknown): void {
  if (error instanceof BackendToolHttpError) {
    process.stderr.write(JSON.stringify({
      error: true,
      statusCode: error.statusCode,
      body: error.body,
    }) + '\n');
  } else if (error instanceof Error) {
    process.stderr.write(JSON.stringify({
      error: true,
      message: error.message,
    }) + '\n');
  } else {
    process.stderr.write(JSON.stringify({
      error: true,
      message: String(error),
    }) + '\n');
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

async function readStdin(): Promise<string> {
  if (process.stdin.readableEnded) {
    return '';
  }

  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

async function readJsonFlag(flag: string | undefined): Promise<JsonObject> {
  if (!flag) {
    return {};
  }

  const text = flag === '-'
    ? await readStdin()
    : await readFileAsync(flag, 'utf8');
  const parsed: unknown = JSON.parse(text);

  if (!isRecord(parsed)) {
    throw new Error('--json must be a JSON object');
  }

  return parsed;
}

function shapeInlineTerminal(event: WaitStreamEvent): WaitStreamEvent {
  if (event.type !== 'terminal') {
    return event;
  }

  if (event.result.workflow === undefined) {
    return event;
  }

  // Workflow jobs write large output to resultPath; inline it here
  const { content: _omitted, ...resultMeta } = event.result;
  return {
    ...event,
    result: {
      ...resultMeta,
      content: readFileSync(event.resultPath, 'utf8'),
    },
  };
}

function normalizeProviderArgv(argv: readonly string[]): string[] {
  if (argv.length < 4) {
    return argv as string[];
  }

  const provider = argv[2];
  const dispatchToken = argv[3];

  if (!providerNameSet.has(provider)) {
    return argv as string[];
  }

  const match = /^coral:([a-z0-9][a-z0-9-]*)$/.exec(dispatchToken);
  if (!match) {
    return argv as string[];
  }

  return [argv[0], argv[1], provider, 'coral', match[1], ...argv.slice(4)];
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
          emit(result);
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
          emit(result);
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
          emit(result);
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
          emit(result);
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

registerProviderCommands(program);

program.command('wait')
  .description('Stream job progress (NDJSON output)')
  .requiredOption('--jobs <ids>', 'Comma-separated job IDs')
  .option('--timeout <seconds>', 'Timeout in seconds', '600')
  .option('--cursor <cursor>', 'Opaque resume cursor (from previous wait output)')
  .option('--inline', 'Embed terminal result content inline instead of emitting the result path')
  .action(async (opts: WaitOptions) => {
    try {
      const jobIds = parseJobIds(opts.jobs);
      const timeoutSeconds = parseIntegerFlag('--timeout', opts.timeout);
      const projectRoot = process.cwd();
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
        const shaped = opts.inline ? shapeInlineTerminal(event) : event;
        process.stdout.write(JSON.stringify({
          cursor: cursorRef.lastEventId ?? null,
          event: shaped,
        }) + '\n');
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
      emit(result);
    } catch (error) {
      emitError(error);
    }
  });

program.command('workflow')
  .description('Execute a workflow pipeline')
  .option('--expression <expr>', 'Pipeline DSL expression (required unless in --json)')
  .option('--init-prompt <text>', 'Initial prompt (required unless in --json)')
  .option('--context <text>', 'Shared context')
  .option('--provider <name>', 'Provider (claude or codex)')
  .option('--work-dir <path>', 'Working directory')
  .option('--stale-timeout-seconds <seconds>', 'Stale job timeout')
  .option('--json <file>', 'JSON payload file (- for stdin)')
  .action(async (opts: WorkflowOptions) => {
    try {
      const base = await readJsonFlag(opts.json);
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
        init_prompt: initPrompt,
      };

      const client = makeClient(process.cwd());
      const result = await client.workflow(expression, payload);
      emit(result);
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
      process.stdout.write(JSON.stringify(status) + '\n');
    } catch (error) {
      emitError(error);
    }
  });

backend.command('shutdown')
  .description('Gracefully shut down backend daemon')
  .action(async () => {
    try {
      const result = await shutdownBackend(pluginRoot);
      if (result.ok) {
        process.stdout.write(JSON.stringify(result) + '\n');
        return;
      }

      process.stderr.write(JSON.stringify(result) + '\n');
      process.exitCode = 1;
    } catch (error) {
      emitError(error);
    }
  });

const discuss = program.command('discuss').description('Discussion operations');

discuss.command('seed')
  .description('Generate discussion personas')
  .requiredOption('--json <file>', 'JSON payload (required; must include controversy_axes array) or - for stdin')
  .option('--count <n>', 'Number of personas')
  .option('--seed <n>', 'Random seed')
  .action(async (opts: DiscussSeedOptions) => {
    try {
      const base = await readJsonFlag(opts.json);
      const args = {
        ...base,
        ...(opts.count !== undefined ? { n: parseIntegerFlag('--count', opts.count) } : {}),
        ...(opts.seed !== undefined ? { seed: parseIntegerFlag('--seed', opts.seed) } : {}),
      };
      const client = makeClient(process.cwd());
      const result = await client.discussSeed(
        args as Parameters<BackendClient['discussSeed']>[0],
      );
      emit(result);
    } catch (error) {
      emitError(error);
    }
  });

discuss.command('start')
  .description('Start a discussion session')
  .requiredOption('--json <file>', 'JSON payload (required; must include agents array) or - for stdin')
  .option('--topic <text>', 'Discussion topic (overrides topic in --json)')
  .action(async (opts: DiscussStartOptions) => {
    try {
      const base = await readJsonFlag(opts.json);
      const args = {
        ...base,
        ...(opts.topic !== undefined ? { topic: opts.topic } : {}),
      };
      const client = makeClient(process.cwd());
      const result = await client.discussStart(
        args as Parameters<BackendClient['discussStart']>[0],
      );
      emit(result);
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
      emit(result);
    } catch (error) {
      emitError(error);
    }
  });

discuss.command('participate')
  .description('Submit bid or speech')
  .option('--json <file>', 'JSON payload file (- for stdin)')
  .requiredOption('--session <id>', 'Session ID')
  .requiredOption('--agent-name <name>', 'Agent name')
  .option('--score <n>', 'Bid score (0-100)')
  .option('--thought <text>', 'Bid thought')
  .option('--content <text>', 'Speech content')
  .action(async (opts: DiscussParticipateOptions) => {
    try {
      const base = await readJsonFlag(opts.json);
      const args = {
        ...base,
        session: opts.session,
        agent_name: opts.agentName,
        ...(opts.score !== undefined ? { score: parseIntegerFlag('--score', opts.score) } : {}),
        ...(opts.thought !== undefined ? { thought: opts.thought } : {}),
        ...(opts.content !== undefined ? { content: opts.content } : {}),
      };
      const client = makeClient(process.cwd());
      const result = await client.discussParticipate(
        args as Parameters<BackendClient['discussParticipate']>[0],
      );
      emit(result);
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
      emit(result);
    } catch (error) {
      emitError(error);
    }
  });

program.parseAsync(normalizeProviderArgv(process.argv)).catch((error) => {
  emitError(error);
  process.exit(1);
});
