import type { Command } from 'commander';
import { z, ZodError } from 'zod';

import { ensureBackend } from '../../client/backend-lifecycle.js';
import { streamWait, type WaitCursorRef } from '../../client/backend-helpers.js';
import { isLivePhase, jobPhaseSchema } from '../../shared/types.js';
import type { ProviderRegistry } from '../../providers/registry.js';
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
  type WaitOptions,
} from '../command-helpers.js';
import { UsageError } from '../errors.js';
import {
  formatAbortResult,
  formatJobsList,
  formatWaitProgress,
  formatWaitQueued,
  formatWaitRunning,
  formatWaitTerminal,
  renderJobsList,
  renderWaitLine,
  type WaitRenderContext,
} from '../format.js';

type JobsOptions = {
  phase?: string;
  provider?: string;
  all?: boolean;
};

type AbortQuerySelector = {
  all: false;
  projectRoot: string;
  phase?: string;
  provider?: string;
};

function normalizeUsageError(error: unknown): unknown {
  if (!(error instanceof ZodError)) {
    return error;
  }

  const message = error.issues
    .map((issue) => {
      if (issue.message.startsWith('--')) {
        return issue.message;
      }
      const path = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
      return `${path}${issue.message}`;
    })
    .join('; ');
  return new UsageError(message);
}

export function registerSessionCommands(program: Command, providerRegistry: ProviderRegistry): void {
  const registeredProviders = getProviderNames(providerRegistry);
  const providerSet = new Set(registeredProviders);
  const livePhaseList = ['queued', 'launching', 'running'] as const;
  const jobsOptionsSchema = z
    .object({
      phase: jobPhaseSchema.optional(),
      provider: z.string().optional(),
      all: z.boolean().optional(),
    })
    .superRefine((value, ctx) => {
      if (value.phase !== undefined && value.all === true) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: '--phase cannot be used with --all',
          path: ['phase'],
        });
      }

      if (value.provider !== undefined && !providerSet.has(value.provider)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `--provider must be one of: ${registeredProviders.join(', ')}`,
          path: ['provider'],
        });
      }
    });
  const abortSelectorSchema = z
    .object({
      jobs: z.string().optional(),
      all: z.boolean().optional(),
      phase: z.string().optional(),
      provider: z.string().optional(),
    })
    .superRefine((value, ctx) => {
      const hasJobs = value.jobs !== undefined;
      const hasAll = value.all === true;
      const hasPhase = value.phase !== undefined;
      const hasProvider = value.provider !== undefined;

      if (!hasJobs && !hasAll && !hasPhase && !hasProvider) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: '--jobs, --all, --phase, or --provider is required',
          path: ['jobs'],
        });
      }

      if (hasJobs && (hasAll || hasPhase || hasProvider)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: '--jobs cannot be used with --all, --phase, or --provider',
          path: ['jobs'],
        });
      }

      if (hasAll && (hasPhase || hasProvider)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: '--all cannot be used with --phase or --provider',
          path: ['all'],
        });
      }

      if (value.phase !== undefined) {
        const phaseResult = jobPhaseSchema.safeParse(value.phase);
        if (!phaseResult.success) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `--phase must be one of: ${livePhaseList.join(', ')}`,
            path: ['phase'],
          });
        } else if (!isLivePhase(phaseResult.data)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `--phase must be one of: ${livePhaseList.join(', ')}`,
            path: ['phase'],
          });
        }
      }

      if (value.provider !== undefined && !providerSet.has(value.provider)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `--provider must be one of: ${registeredProviders.join(', ')}`,
          path: ['provider'],
        });
      }
    });

  const jobsCommand = program.command('jobs');
  jobsCommand
    .description('List jobs for the current project')
    .option('--phase <phase>', 'Limit jobs to a single phase')
    .option('--provider <name>', 'Limit jobs to a registered provider')
    .option('--all', 'Include terminal jobs in addition to live jobs')
    .action(async (opts: JobsOptions) => {
      const outputFormat = getOutputFormat(jobsCommand);

      try {
        const parsed = jobsOptionsSchema.parse(opts);
        const projectRoot = process.cwd();
        const client = makeClient(projectRoot);
        const result = await client.listJobs({
          projectRoot,
          ...(parsed.phase !== undefined ? { phase: parsed.phase } : {}),
          ...(parsed.provider !== undefined ? { provider: parsed.provider } : {}),
          ...(parsed.all === true ? { all: true } : {}),
        });
        const rows = formatJobsList(result);

        if (outputFormat === 'json') {
          process.stdout.write(JSON.stringify(rows) + '\n');
          return;
        }

        process.stdout.write(
          renderJobsList(rows, {
            phase: parsed.phase,
            provider: parsed.provider,
            all: parsed.all,
          }) + '\n',
        );
      } catch (error) {
        emitError(normalizeUsageError(error), outputFormat);
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
    .option('--jobs <ids>', 'Comma-separated job IDs')
    .option('--all', 'Abort all live jobs in the current project')
    .option('--phase <phase>', 'Abort live jobs in a single phase')
    .option('--provider <name>', 'Abort live jobs for a registered provider')
    .action(async (opts: AbortOptions) => {
      const outputFormat = getOutputFormat(abortCommand);

      try {
        const parsed = abortSelectorSchema.parse(opts);
        const projectRoot = process.cwd();
        const client = makeClient(projectRoot);

        if (parsed.jobs !== undefined) {
          const result = await client.abortJobs(parseJobIds(parsed.jobs));
          emit(result, outputFormat, formatAbortResult);
          return;
        }

        const selector: AbortQuerySelector = {
          projectRoot,
          all: false,
          ...(parsed.phase !== undefined ? { phase: parsed.phase } : {}),
          ...(parsed.provider !== undefined ? { provider: parsed.provider } : {}),
        };
        const jobs = await client.listJobs(selector);
        const jobIds = jobs.jobs.map(({ jobId }) => jobId);

        if (jobIds.length === 0) {
          emit({ aborted: [], notFound: [] }, outputFormat, formatAbortResult);
          return;
        }

        const result = await client.abortJobs(jobIds);
        emit(result, outputFormat, formatAbortResult);
      } catch (error) {
        emitError(normalizeUsageError(error), outputFormat);
      }
    });
}
