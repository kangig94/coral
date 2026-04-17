import type { Command } from 'commander';

import { ensureBackend } from '../../client/backend-lifecycle.js';
import { streamWait, type WaitCursorRef } from '../../client/backend-helpers.js';
import type { ProviderRegistry } from '../../providers/registry.js';
import type { SessionListResult } from '../format.js';
import {
  emit,
  emitError,
  getOutputFormat,
  getPluginRoot,
  getProviderNames,
  getTerminalContext,
  makeClient,
  parseIntegerFlag,
  parseJobIds,
  shapeWaitOutputRecord,
  type AbortOptions,
  type ProviderListOptions,
  type WaitOptions,
} from '../command-helpers.js';
import {
  formatAbortResult,
  formatProviderList,
  formatWaitProgress,
  formatWaitQueued,
  formatWaitRunning,
  formatWaitTerminal,
  renderWaitLine,
  type WaitRenderContext,
} from '../format.js';
import { UsageError } from '../errors.js';

export function registerSessionCommands(program: Command, providerRegistry: ProviderRegistry): void {
  const listCommand = program.command('list');
  listCommand
    .description('List sessions')
    .option('--provider <name>', 'Filter by provider')
    .action(async (opts: ProviderListOptions) => {
      const outputFormat = getOutputFormat(listCommand);

      try {
        const client = makeClient(process.cwd());
        if (opts.provider !== undefined && !getProviderNames(providerRegistry).includes(opts.provider)) {
          throw new UsageError(`Unknown provider: ${opts.provider}`);
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
        const { port, host, token } = await ensureBackend(getPluginRoot() || undefined);
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
            case 'running':
              formatted = formatWaitRunning(event, cursor);
              break;
          }

          process.stdout.write(renderWaitLine(formatted, ctx));
          if ((event.type === 'terminal' || event.type === 'running') && ctx.isTTY) {
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
}
