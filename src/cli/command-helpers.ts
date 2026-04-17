declare const __PLUGIN_ROOT__: string;

import { existsSync, readFileSync } from 'node:fs';
import type { Command } from 'commander';

import {
  BackendClient,
  type AcceptedLaunchResponse,
  type CallerContext,
} from '../client/http-client.js';
import { ensureBackend } from '../client/backend-lifecycle.js';
import { collectCoralEnv } from '../shared/utils.js';
import { MAX_INLINE } from '../shared/schemas.js';
import type { WaitStreamEvent } from '../shared/types.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { buildErrorEnvelope, UsageError } from './errors.js';
import {
  formatError,
  formatLaunch,
} from './format.js';
import { launchAndFollow } from './follow.js';
import { isJsonObject } from './parse.js';

type CliOutputFormat = 'text' | 'json';

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
  timeout: string;
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

type WaitOutputRecord = {
  cursor: string | null;
  event: unknown;
};

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

export function makeClient(projectRoot: string): BackendClient {
  const defaultContext: CallerContext = { pluginRoot, projectRoot, coralEnv: collectCoralEnv() };
  return new BackendClient({
    ensureBackend: () => ensureBackend(pluginRoot || undefined),
    defaultContext,
  });
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

export function emitError(error: unknown, outputFormat: CliOutputFormat): void {
  const { envelope, exitCode } = buildErrorEnvelope(error);
  if (outputFormat === 'json') {
    process.stderr.write(JSON.stringify(envelope) + '\n');
  } else {
    process.stderr.write(formatError(error) + '\n');
  }
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

export function emitAcceptedLaunchResponse(decision: AcceptedLaunchResponse, outputFormat: CliOutputFormat): void {
  const text = outputFormat === 'text' ? formatLaunch(decision) : JSON.stringify(decision);
  process.stdout.write(text + '\n');
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
  outputFormat: CliOutputFormat,
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

  // Successful follow returns the terminal job exit code (0-255).
  // Follow-level failures route through emitError and return the envelope exit code instead.
  process.exitCode = await launchAndFollow({
    launchResult: result,
    abortJob: async (jobId) => {
      await client.abortJobs([jobId]);
    },
    pluginRoot,
    projectRoot: process.cwd(),
    outputFormat,
    emitError,
    ...getTerminalContext(),
  });
}

export function shapeWaitOutputRecord(
  event: WaitStreamEvent,
  cursor: string | null,
  embed: boolean,
): WaitOutputRecord {
  if (event.type === 'progress' || event.type === 'queued') {
    return { cursor: null, event };
  }

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

export function getPluginRoot(): string {
  return pluginRoot;
}
