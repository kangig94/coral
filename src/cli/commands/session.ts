import type { Command } from 'commander';
import { z } from 'zod';

import { BackendToolHttpError } from '../../transport/http/errors.js';
import type { CauseRef } from '../../causality/cause-ref.js';
import { isLivePhase, jobPhaseSchema } from '../../jobs/phase.js';
import {
  parseSerializedWaitCursor,
  serializeWaitCursor,
  type WaitCursor,
  type WaitStreamEvent,
} from '../../jobs/wait.js';
import type { JobStatus } from '../../jobs/records.js';
import type { ProviderRegistry } from '../../providers/registry.js';
import { getProviderNames, makeClient, WAIT_TIMEOUT_SECONDS, type AbortOptions } from '../dispatch.js';
import { emitError, getTerminalContext } from '../emit.js';
import { parseJobIds } from '../flags.js';
import { flushPendingReadStoreNote } from '../read-store.js';
import { normalizeUsageError } from '../errors.js';
import { formatAbortResult, formatJobsList, renderJobsList } from '../format/jobs.js';
import { openCliCauseRefRenderer } from '../cause-renderer.js';
import { mapWaitSubscriptionError } from '../wait-stream-error.js';
import {
  formatWaitProgress,
  formatWaitQueued,
  formatWaitTerminal,
  formatWaitWaiting,
  renderWaitLine,
  type WaitRenderContext,
} from '../format/wait.js';

type JobsOptions = {
  phase?: string;
  provider?: string;
  all?: boolean;
};

type AbortQuerySelector = {
  all: false;
  projectRoot: string;
  phase?: JobStatus['phase'];
  provider?: string;
};

type WaitJobsOptions = {
  cursor?: string;
  embed?: boolean;
};

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
    .description('List live jobs across all projects (current project first, then KB jobs, then other directories)')
    .option('--phase <phase>', 'Limit jobs to a single phase')
    .option('--provider <name>', 'Limit jobs to a registered provider')
    .option('--all', 'Include terminal jobs in addition to live jobs')
    .action(async (opts: JobsOptions) => {
      try {
        const parsed = jobsOptionsSchema.parse(opts);
        const projectRoot = process.cwd();
        const client = makeClient(projectRoot, jobsCommand);
        // List every live job across all projects (allProjects bypasses the
        // dispatch-level cwd default), then group by directory at render time
        // with the current project surfaced first.
        const result = await client.listJobs({
          allProjects: true,
          ...(parsed.phase !== undefined ? { phase: parsed.phase } : {}),
          ...(parsed.provider !== undefined ? { provider: parsed.provider } : {}),
          ...(parsed.all === true ? { all: true } : {}),
        });
        const rows = formatJobsList(result);

        process.stdout.write(
          renderJobsList(rows, {
            phase: parsed.phase,
            provider: parsed.provider,
            all: parsed.all,
            cwd: projectRoot,
          }) + '\n',
        );
        flushPendingReadStoreNote('text');
      } catch (error) {
        emitError(normalizeUsageError(error));
      }
    });

  async function runWaitJobs(jobIds: string[], opts: WaitJobsOptions, command: Command): Promise<void> {
    try {
      const timeoutSeconds = WAIT_TIMEOUT_SECONDS;
      const projectRoot = process.cwd();
      const embed = opts.embed === true;
      const client = makeClient(projectRoot, command);
      const parsedCursor = parseSerializedWaitCursor(opts.cursor);
      if (opts.cursor && !parsedCursor) {
        throw new BackendToolHttpError('Invalid Last-Event-ID cursor', 400, {
          code: 'invalid_request',
          message: 'Invalid Last-Event-ID cursor',
        });
      }

      const currentCursor: WaitCursor = { afterSeq: parsedCursor?.afterSeq ?? 0 };
      const jobLabels = jobIds.length > 1 ? new Map(jobIds.map((id, index) => [id, `j${index}`])) : null;
      const causeRenderer = openCliCauseRefRenderer(projectRoot);

      try {
        const subscription = await client.subscribe<WaitStreamEvent>('jobs.wait', {
          jobIds,
          timeoutSeconds,
          projectRoot,
          ...(parsedCursor ? { cursor: parsedCursor } : {}),
        });

        try {
          for await (const event of subscription) {
            if (event.type === 'progress' || event.type === 'terminal') {
              currentCursor.afterSeq = event.seq;
            }

            const cursor = currentCursor.afterSeq > 0 ? serializeWaitCursor(currentCursor) : null;

            const ctx: WaitRenderContext = getTerminalContext();
            const renderCauseRef = causeRenderer.render;
            let formatted: string;

            switch (event.type) {
              case 'progress':
                formatted = formatWaitProgress(event, jobLabels?.get(event.jobId));
                break;
              case 'queued':
                formatted = formatWaitQueued(event, jobLabels?.get(event.jobId));
                break;
              case 'terminal': {
                const describer = renderCauseRef
                  ? { describeCauseRef: (ref: CauseRef) => renderCauseRef(ref, event.result.outcome) }
                  : {};
                formatted = formatWaitTerminal(event, cursor, embed, describer);
                break;
              }
              case 'waiting':
                formatted = formatWaitWaiting(event, cursor);
                break;
            }

            process.stdout.write(renderWaitLine(formatted, ctx));
            if ((event.type === 'terminal' || event.type === 'waiting') && ctx.isTTY) {
              process.stdout.write('\n');
            }
          }
        } finally {
          await subscription.close();
        }
      } finally {
        causeRenderer.close();
      }
    } catch (error) {
      emitError(mapWaitSubscriptionError(error));
    }
  }

  const waitCommand = program.command('wait');
  waitCommand.description('Stream job progress (text output)');

  const waitJobsCommand = waitCommand.command('jobs');
  waitJobsCommand
    .description('Stream job progress for one or more jobs')
    .argument('<jobIds...>', 'Job IDs')
    .option('--cursor <cursor>', 'Opaque resume cursor (from previous wait output)')
    .option('--embed', 'Embed terminal result content when size permits (path is always present)')
    .action(async (jobIdArgs: string[], opts: WaitJobsOptions) => {
      await runWaitJobs(parseJobIds(jobIdArgs.join(' ')), opts, waitJobsCommand);
    });

  const abortCommand = program.command('abort');
  abortCommand
    .description('Abort running jobs')
    .option('--jobs <ids>', 'Comma-separated job IDs')
    .option('--all', 'Abort all live jobs in the current project (plus shared KB jobs)')
    .option('--phase <phase>', 'Abort live jobs in a single phase (current project + KB jobs)')
    .option('--provider <name>', 'Abort live jobs for a registered provider')
    .action(async (opts: AbortOptions) => {
      try {
        const parsed = abortSelectorSchema.parse(opts);
        const projectRoot = process.cwd();
        const client = makeClient(projectRoot, abortCommand);

        if (parsed.jobs !== undefined) {
          const result = await client.abortJobs(parseJobIds(parsed.jobs));
          process.stdout.write(formatAbortResult(result) + '\n');
          return;
        }

        const selector: AbortQuerySelector = {
          projectRoot,
          all: false,
          ...(parsed.phase !== undefined ? { phase: parsed.phase as JobStatus['phase'] } : {}),
          ...(parsed.provider !== undefined ? { provider: parsed.provider } : {}),
        };
        const jobs = await client.listJobs(selector);
        const jobIds = jobs.jobs.map(({ jobId }) => jobId);

        if (jobIds.length === 0) {
          process.stdout.write(formatAbortResult({ aborted: [], notFound: [] }) + '\n');
          return;
        }

        const result = await client.abortJobs(jobIds);
        process.stdout.write(formatAbortResult(result) + '\n');
      } catch (error) {
        emitError(normalizeUsageError(error));
      }
    });
}
