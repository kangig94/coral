import type { Command } from 'commander';
import { z } from 'zod';

import { isLivePhase, LIVE_JOB_PHASES, jobPhaseSchema } from '../../jobs/phase.js';
import type { JobStatus } from '../../jobs/records.js';
import type { ProviderRegistry } from '../../providers/registry.js';
import { getProviderNames, makeClient, type AbortOptions } from '../dispatch.js';
import { emitError, getTerminalContext } from '../emit.js';
import { parseJobIds } from '../flags.js';
import { flushPendingReadStoreNote } from '../read-store.js';
import { UsageError, normalizeUsageError } from '../errors.js';
import { formatAbortResult, formatJobDetail, formatJobsList, renderJobsList } from '../format/jobs.js';
import { openCliCauseRefRenderer } from '../cause-renderer.js';
import { followJobs } from '../follow.js';

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
  verbose?: boolean;
};

export function registerSessionCommands(program: Command, providerRegistry: ProviderRegistry): void {
  const registeredProviders = getProviderNames(providerRegistry);
  const providerSet = new Set(registeredProviders);
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
      all: z.boolean().optional(),
      phase: z.string().optional(),
      provider: z.string().optional(),
    })
    .superRefine((value, ctx) => {
      const hasAll = value.all === true;
      const hasPhase = value.phase !== undefined;
      const hasProvider = value.provider !== undefined;

      if (!hasAll && !hasPhase && !hasProvider) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'abort requires jobs <ids...>, --all, --phase, or --provider',
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
            message: `--phase must be one of: ${LIVE_JOB_PHASES.join(', ')}`,
            path: ['phase'],
          });
        } else if (!isLivePhase(phaseResult.data)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `--phase must be one of: ${LIVE_JOB_PHASES.join(', ')}`,
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

  const jobsDetailCommand = jobsCommand.command('detail');
  jobsDetailCommand
    .description('Show detailed status for one job')
    .argument('<jobId>', 'Job ID')
    .action(async (jobId: string) => {
      try {
        const projectRoot = process.cwd();
        const client = makeClient(projectRoot, jobsDetailCommand);
        const causeRenderer = openCliCauseRefRenderer(projectRoot);
        try {
          const result = await client.detailJob(jobId);
          const renderCauseRef = causeRenderer.render;
          process.stdout.write(
            formatJobDetail(
              result,
              renderCauseRef === undefined ? undefined : (ref) => renderCauseRef(ref, result.exit?.outcome),
            ) + '\n',
          );
          flushPendingReadStoreNote('text');
        } finally {
          causeRenderer.close();
        }
      } catch (error) {
        emitError(normalizeUsageError(error));
      }
    });

  async function runWaitJobs(jobIds: string[], opts: WaitJobsOptions, command: Command): Promise<void> {
    const projectRoot = process.cwd();
    const client = makeClient(projectRoot, command);

    process.exitCode = await followJobs({
      start: { kind: 'jobs', jobIds, ...(opts.cursor === undefined ? {} : { serializedCursor: opts.cursor }) },
      reconnectPolicy: 'bounded',
      projectRoot,
      emitError,
      render: {
        ...getTerminalContext(),
        embed: opts.embed === true,
        verbose: opts.verbose === true,
      },
      abortJobs: async (ids) => {
        await client.abortJobs([...ids]);
      },
      connect: async ({ jobIds: activeJobIds, cursor, timeoutSeconds, signal }) => ({
        kind: 'subscription',
        // Wire boundary: the IPC transport hands back an unvalidated `unknown` per event. `followJobs`
        // validates each one through `parseWaitStreamEventValue` before it becomes a `WaitStreamEvent`.
        subscription: await client.subscribe<unknown>(
          'jobs.wait',
          {
            jobIds: [...activeJobIds],
            timeoutSeconds,
            projectRoot,
            // Declared by every subscriber in this build that can render the event. A coordinator withholds
            // `interrupted` from anyone who does not say this, which is how an already-installed CLI — whose
            // wait switch has no arm for an unknown type — keeps working against a newer backend.
            supportsInterrupted: true,
            ...(cursor ? { cursor } : {}),
          },
          { signal },
        ),
      }),
    });
  }

  const waitCommand = program.command('wait');
  waitCommand.description('Stream job progress (text output)');

  const waitJobsCommand = waitCommand.command('jobs');
  waitJobsCommand
    .description('Stream job progress for one or more jobs')
    .argument('<jobIds...>', 'Job IDs')
    .option('--cursor <cursor>', 'Opaque resume cursor (from previous wait output)')
    .option('--embed', 'Embed terminal result content when size permits (path is always present)')
    .option('--verbose', 'Show detailed usage breakdown on terminal events')
    .addHelpText(
      'after',
      '\nExits 75 if jobs are still pending when the wait window closes (not 0); rerun with the printed ' +
        '--cursor to keep waiting on the same jobs.\n',
    )
    .action(async (jobIdArgs: string[], opts: WaitJobsOptions) => {
      await runWaitJobs(parseJobIds(jobIdArgs.join(' ')), opts, waitJobsCommand);
    });

  const abortCommand = program.command('abort');
  abortCommand
    .description('Abort running jobs')
    .option('--all', 'Abort all live jobs in the current project (plus shared KB jobs)')
    .option('--phase <phase>', 'Abort live jobs in a single phase (current project + KB jobs)')
    .option('--provider <name>', 'Abort live jobs for a registered provider')
    .action(async (opts: AbortOptions) => {
      try {
        const parsed = abortSelectorSchema.parse(opts);
        const projectRoot = process.cwd();
        const client = makeClient(projectRoot, abortCommand);

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

  const abortJobsCommand = abortCommand.command('jobs');
  abortJobsCommand
    .description('Abort one or more jobs by ID')
    .argument('<jobIds...>', 'Job IDs')
    .action(async (jobIdArgs: string[]) => {
      try {
        const parentOpts = abortCommand.opts<AbortOptions>();
        if (parentOpts.all === true || parentOpts.phase !== undefined || parentOpts.provider !== undefined) {
          throw new UsageError('abort jobs cannot be used with --all, --phase, or --provider');
        }
        const projectRoot = process.cwd();
        const client = makeClient(projectRoot, abortJobsCommand);
        const result = await client.abortJobs(parseJobIds(jobIdArgs.join(' ')));
        process.stdout.write(formatAbortResult(result) + '\n');
      } catch (error) {
        emitError(normalizeUsageError(error));
      }
    });
}
