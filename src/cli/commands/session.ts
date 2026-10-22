import { waitExecutionSelectionsSchema, type WaitExecutionSelection } from '../../jobs/wait/execution-selection.js';
import { decodeWaitCursor, WAIT_CURSOR_REPLAY_NOTICE } from '../../jobs/wait/cursor.js';
import type { WaitCursor } from '../../jobs/wait/contract.js';
import { parseWaitSnapshot } from '../../jobs/wait/snapshot.js';
import {
  formatWaitSnapshot,
  formatWaitContinuation,
  waitCommandPrefix,
  waitContinuationCommand,
} from '../format/wait.js';
import { mapWaitSubscriptionError, SOFT_CURSOR_REFUSALS } from '../wait-stream-error.js';
import { MAX_WAIT_JOB_IDS } from '../../jobs/wait/stream-event.js';
import { BackendToolHttpError } from '../../transport/http/errors.js';
import { isRecord } from '../../infra/json.js';
import { getWaitInvocation, WaitInvocationEnded, validateWaitJobsOptions } from '../wait-invocation.js';
import type { Command } from 'commander';
import { z } from 'zod';

import { isLivePhase, jobPhaseSchema } from '../../jobs/phase.js';
import type { JobStatus } from '../../jobs/records.js';
import { waitCommandPaths } from '../../coordinator/handoff-routing/wait-command.js';
import type { AbortResult } from '../../jobs/contracts/abort-registry.js';
import type { ProviderRegistry } from '../../providers/registry.js';
import { getProviderNames, makeClient } from '../dispatch.js';
import { emitError, getTerminalContext, handleLaunchResult } from '../emit.js';
import { parseJobIds, resolveInput } from '../flags.js';
import { flushPendingReadStoreNote } from '../read-store.js';
import { UsageError, WaitOutputError, WaitSnapshotResponseError, normalizeUsageError } from '../errors.js';
import { WaitBuildMismatchError } from '../../coordinator/handoff-routing/wait-invocation.js';
import {
  formatAbortResult,
  formatJobDetail,
  formatJobSendResult,
  formatJobsList,
  renderJobsList,
} from '../format/jobs.js';
import { openCliCauseRefRenderer } from '../cause-renderer.js';
import { followJobs } from '../follow.js';

const ABORT_REFUSED_EXIT_CODE = 3;

type JobsOptions = {
  mine?: boolean;
  unwaited?: boolean;
  json?: boolean;
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

type AbortOptions = {
  all?: boolean;
  phase?: string;
  provider?: string;
};

type WaitJobsOptions = {
  snapshot?: boolean;
  unbounded?: boolean;
  lines?: string;
  cursor?: string;
  executionSelection?: string;
  embed?: boolean;
  verbose?: boolean;
};

export function registerSessionCommands(program: Command, providerRegistry: ProviderRegistry): void {
  const registeredProviders = getProviderNames(providerRegistry);
  const jobsCommand = program.command('jobs').description('List, monitor, and manage jobs');
  registerJobsListCommand(jobsCommand, registeredProviders);
  registerJobsWaitCommand(jobsCommand, program);
  registerJobsAbortCommand(jobsCommand, registeredProviders);
  registerJobsSendCommand(jobsCommand);
  registerJobsDetailCommand(jobsCommand);
  registerJobsReleaseCommand(jobsCommand);
}

function registerJobsListCommand(jobsCommand: Command, registeredProviders: string[]): void {
  const providerSet = new Set(registeredProviders);
  const jobsOptionsSchema = z
    .object({
      phase: jobPhaseSchema.optional(),
      provider: z.string().optional(),
      all: z.boolean().optional(),
      mine: z.boolean().optional(),
      unwaited: z.boolean().optional(),
      json: z.boolean().optional(),
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

  const jobsListCommand = jobsCommand.command('list');
  jobsListCommand
    .description('List live jobs across all projects (current project first, then KB jobs, then other directories)')
    .option('--phase <phase>', 'Limit jobs to a single phase')
    .option('--provider <name>', 'Limit jobs to a registered provider')
    .option('--all', 'Include terminal jobs in addition to live jobs')
    .option('--mine', 'List live jobs launched by this session (CORAL_OWNER)')
    .option('--unwaited', 'Exclude jobs with an active wait or a release')
    .option('--json', 'Print a JSON array of jobs')
    .action(async (opts: JobsOptions) => {
      try {
        const parsed = jobsOptionsSchema.parse(opts);
        const projectRoot = process.cwd();
        const client = makeClient(projectRoot, jobsListCommand);
        const result = await client.listJobs({
          allProjects: true,
          ...(parsed.mine === true ? { mine: true } : {}),
          ...(parsed.unwaited === true ? { unwaited: true } : {}),
          ...(parsed.phase !== undefined ? { phase: parsed.phase } : {}),
          ...(parsed.provider !== undefined ? { provider: parsed.provider } : {}),
          ...(parsed.all === true ? { all: true } : {}),
        });
        if (parsed.json === true) {
          process.stdout.write(JSON.stringify(result.jobs) + '\n');
          return;
        }
        const rows = formatJobsList(result);

        process.stdout.write(
          renderJobsList(rows, {
            phase: parsed.phase,
            provider: parsed.provider,
            all: parsed.all,
            mine: parsed.mine,
            unwaited: parsed.unwaited,
            cwd: projectRoot,
          }) + '\n',
        );
        flushPendingReadStoreNote('text');
      } catch (error) {
        emitError(normalizeUsageError(error));
      }
    });
}

function registerJobsWaitCommand(jobsCommand: Command, program: Command): void {
  configureWaitJobsCommand(jobsCommand.command(waitCommandPaths.current.split(' ')[1])).action(runWaitJobs);
  registerLegacyWaitJobs(program, runWaitJobs);
}

async function runWaitJobs(jobIdArgs: string[], opts: WaitJobsOptions, command: Command): Promise<void> {
  try {
    const lines = validateWaitJobsOptions(opts);
    const jobIds = parseJobIds(jobIdArgs.join(' '));
    if (new Set(jobIds).size !== jobIds.length)
      throw new UsageError('Each job ID must appear only once. Remove the duplicate job IDs and rerun.');
    if (jobIds.length > MAX_WAIT_JOB_IDS)
      throw new UsageError(`At most ${MAX_WAIT_JOB_IDS} jobs may be waited on at once. Split the IDs across commands.`);
    const projectRoot = process.cwd();
    const client = makeClient(projectRoot, command);
    if (opts.snapshot) await runWaitSnapshot(client, jobIds, projectRoot, opts, lines);
    else await runStreamingWaitJobs(client, jobIds, projectRoot, opts);
  } catch (error) {
    if (error instanceof WaitInvocationEnded) throw error;
    emitError(normalizeUsageError(error));
  }
}

function registerJobsAbortCommand(jobsCommand: Command, registeredProviders: string[]): void {
  const providerSet = new Set(registeredProviders);
  const livePhaseList = ['queued', 'launching', 'running'] as const;
  const abortUsage =
    'Use one of these forms:\n' +
    '  coral-cli jobs abort <jobIds...>\n' +
    '  coral-cli jobs abort --all\n' +
    '  coral-cli jobs abort [--phase <phase>] [--provider <name>]\n' +
    '--phase and --provider may be combined; specify at least one.';
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
          message: abortUsage,
        });
      }

      if (hasAll && (hasPhase || hasProvider)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `--all cannot be used with --phase or --provider. ${abortUsage}`,
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

  const abortJobsCommand = jobsCommand.command('abort');
  abortJobsCommand
    .description('Abort jobs by ID or live jobs in the current work directory (including shared KB jobs)')
    .argument('[jobIds...]', 'Job IDs')
    .addHelpText('after', `\n${abortUsage}\n`)
    .option('--all', 'Abort all live jobs in the current work directory')
    .option('--phase <phase>', 'Abort live jobs in a single phase in the current work directory')
    .option('--provider <name>', 'Abort live jobs for a registered provider in the current work directory')
    .action(async (jobIdArgs: string[], opts: AbortOptions) => {
      try {
        const hasIds = jobIdArgs.length > 0;
        const hasSelector = opts.all === true || opts.phase !== undefined || opts.provider !== undefined;
        if (hasIds === hasSelector) throw new UsageError(abortUsage);
        const parsed = hasIds ? undefined : abortSelectorSchema.parse(opts);
        const projectRoot = process.cwd();
        const client = makeClient(projectRoot, abortJobsCommand);
        let jobIds = hasIds ? parseJobIds(jobIdArgs.join(' ')) : [];
        if (parsed !== undefined) {
          const selector: AbortQuerySelector = {
            projectRoot,
            all: false,
            ...(parsed.phase !== undefined ? { phase: parsed.phase as JobStatus['phase'] } : {}),
            ...(parsed.provider !== undefined ? { provider: parsed.provider } : {}),
          };
          const jobs = await client.listJobs(selector);
          jobIds = jobs.jobs.map(({ jobId }) => jobId);
        }
        if (jobIds.length === 0) {
          reportAbortResult({ aborted: [], notFound: [] });
          return;
        }
        reportAbortResult(await client.abortJobs(jobIds));
      } catch (error) {
        emitError(normalizeUsageError(error));
      }
    });
}

function registerJobsSendCommand(jobsCommand: Command): void {
  const sendCommand = jobsCommand.command('send');
  const inputUsage = 'Input is required. Use -i <text>, -i <file>, or -i - (stdin).';
  sendCommand
    .description('Steer a running provider turn or continue its ended conversation.')
    .argument('<jobId>', 'Job ID')
    .option(
      '-i, --input <text-or-file...>',
      'Message input (required; tokens are joined with single spaces; the whole input is read if it names an existing regular file, or stdin if exactly -; otherwise literal text)',
    )
    .option('-d, --detach', 'Return immediately after launching a continuation')
    .action(async (jobId: string, opts: { input?: string[]; detach?: boolean }) => {
      try {
        if (opts.input === undefined) throw new UsageError(inputUsage);
        const input = resolveInput(opts.input);
        if (input.trim().length === 0) throw new UsageError(inputUsage);
        const result = await makeClient(process.cwd(), sendCommand).sendJob(jobId, input);
        if (result.state === 'launched') {
          await handleLaunchResult(result.launch, opts.detach);
          return;
        }
        const output = formatJobSendResult(jobId, result, { inputTokens: opts.input });
        (output.exitCode === 0 ? process.stdout : process.stderr).write(output.text + '\n');
        process.exitCode = output.exitCode;
      } catch (error) {
        emitError(normalizeUsageError(error));
      }
    });
}

function reportAbortResult(result: AbortResult): void {
  process.stdout.write(formatAbortResult(result) + '\n');
  if ((result.refused?.length ?? 0) + (result.held?.length ?? 0) + (result.abandoned?.length ?? 0) > 0) {
    process.exitCode = ABORT_REFUSED_EXIT_CODE;
  }
}

function registerJobsDetailCommand(jobsCommand: Command): void {
  const jobsDetailCommand = jobsCommand.command('detail');
  jobsDetailCommand
    .description('Show detailed status for one job')
    .argument('<jobId>', 'Job ID')
    .option('--full', 'Print full retained terminal content and diagnostics')
    .action(async (jobId: string, opts: { full?: boolean }) => {
      try {
        const projectRoot = process.cwd();
        const client = makeClient(projectRoot, jobsDetailCommand);
        const causeRenderer = openCliCauseRefRenderer(projectRoot);
        try {
          const result = await client.detailJob(jobId);
          const workflowChildren =
            result.status.jobKind === 'workflow'
              ? (await client.listJobs({ allProjects: true, all: true })).jobs.filter(
                  ({ status }) => status.parentWorkflowJobId === result.status.jobId,
                )
              : [];
          const renderCauseRef = causeRenderer.render;
          process.stdout.write(
            formatJobDetail(
              result,
              renderCauseRef === undefined
                ? undefined
                : (ref) => renderCauseRef(ref, result.exit?.outcome, result.epochKey),
              workflowChildren,
              opts.full === true,
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
}

function registerJobsReleaseCommand(jobsCommand: Command): void {
  const jobsReleaseCommand = jobsCommand.command('release');
  jobsReleaseCommand
    .description('Exempt jobs from the session wait requirement without stopping them')
    .argument('<jobIds...>', 'Job IDs')
    .action(async (jobIds: string[]) => {
      try {
        const result = await makeClient(process.cwd(), jobsReleaseCommand).releaseJobs(jobIds.flatMap(parseJobIds));
        for (const jobId of result.released) process.stdout.write(`Job ${jobId} released; it continues running.\n`);
        for (const jobId of result.unknown)
          process.stdout.write(
            `Job ${jobId} is unknown; nothing released. Run coral-cli jobs list to check the job ID.\n`,
          );
        for (const jobId of result.terminal)
          process.stdout.write(`Job ${jobId} is already terminal; nothing released.\n`);
      } catch (error) {
        emitError(normalizeUsageError(error));
      }
    });
}

function configureWaitJobsCommand(command: Command): Command {
  return command
    .description(
      'Monitor jobs until the first terminal or ~590 s, then return a continuation; --snapshot returns immediately; --unbounded drops the ~590 s bound',
    )
    .argument('<jobIds...>', 'Job IDs')
    .option('--cursor <cursor>', 'Progress seq cursor (from previous wait output)')
    .option('--execution-selection <JSON>', 'Execution admission and delivery state from a continuation')
    .option(
      '--snapshot',
      'Read an immediate snapshot; continuations keep --snapshot; drop it explicitly to switch to a blocking wait',
    )
    .option('--lines <N>', 'Most recent progress lines per job with --snapshot (1..500, default 20; no cursor)')
    .option(
      '--unbounded',
      'Run only in a background shell: monitor until the first terminal with no ~590 s bound, which a foreground shell kills at its own timeout without a continuation. Continuations keep --unbounded (cannot use with --snapshot)',
    )
    .option(
      '--embed',
      'Embed terminal result content when size permits; artifact availability is reported separately (cannot use with --snapshot)',
    )
    .option('--verbose', 'Show detailed usage breakdown on terminal events (cannot use with --snapshot)')
    .addHelpText(
      'after',
      '\nThe first failed terminal in request order keeps its mapped exit code, even with pending siblings.\n' +
        'Otherwise permanent refusals exit 1; remaining collection work exits 75; exhausted successful sets exit 0.\n' +
        'Ctrl+C stops monitoring with exit 75 and a continuation; it never aborts jobs.\n' +
        'Run the continuation or remediation command printed in the output.\n',
    );
}

function registerLegacyWaitJobs(
  program: Command,
  action: (jobIds: string[], opts: WaitJobsOptions, command: Command) => Promise<void>,
): void {
  const [group, verb] = waitCommandPaths.legacyWaitJobs.split(' ');
  const wait = program.command(group, { hidden: true });
  configureWaitJobsCommand(wait.command(verb, { hidden: true })).action(action);
}

async function runWaitSnapshot(
  client: ReturnType<typeof makeClient>,
  jobIds: string[],
  projectRoot: string,
  opts: WaitJobsOptions,
  lines: number | undefined,
): Promise<void> {
  const invocation = getWaitInvocation();
  const executionSelections = parseExecutionSelections(opts.executionSelection, jobIds);
  let cursor: WaitCursor | undefined;
  if (opts.cursor !== undefined) {
    if (decodeWaitCursor(opts.cursor).kind === 'decoded') cursor = opts.cursor;
    else process.stdout.write(`${WAIT_CURSOR_REPLAY_NOTICE} This snapshot shows the latest progress tail.\n`);
  }
  const reset = () => {
    cursor = undefined;
    process.stdout.write(`${WAIT_CURSOR_REPLAY_NOTICE} This snapshot shows the latest progress tail.\n`);
  };
  const read = () =>
    client.snapshotJobsWait({
      jobIds,
      projectRoot,
      ...(cursor === undefined ? {} : { cursor }),
      ...(executionSelections === undefined ? {} : { executionSelections }),
      ...(lines === undefined ? {} : { lines }),
    });
  let response;
  try {
    response = await read();
  } catch (error) {
    const mapped = mapWaitSubscriptionError(error, 'snapshot');
    if (mapped instanceof WaitBuildMismatchError) throw mapped;
    if (
      !(mapped instanceof BackendToolHttpError) ||
      !isRecord(mapped.body) ||
      !SOFT_CURSOR_REFUSALS.includes(String(mapped.body.code))
    )
      throw mapped;
    reset();
    response = await read();
  }
  invocation?.check();
  let snapshot;
  try {
    snapshot = parseWaitSnapshot(response, jobIds);
  } catch {
    throw new WaitSnapshotResponseError(
      invocation?.originalCommand ??
        `${waitCommandPrefix()} ${jobIds.join(' ')} --snapshot${opts.cursor === undefined ? '' : ` --cursor ${opts.cursor}`}${opts.lines === undefined ? '' : ` --lines ${opts.lines}`}${opts.executionSelection === undefined ? '' : ` --execution-selection '${opts.executionSelection.replaceAll("'", "'\\''")}'`}`,
    );
  }
  const output = formatWaitSnapshot(snapshot) + '\n';
  const continuation =
    formatWaitContinuation(snapshot.remainingJobIds, snapshot.cursor, 'snapshot', snapshot.executionSelections) + '\n';
  const write = () =>
    new Promise<void>((resolve, reject) =>
      process.stdout.write(output, (error) => (error ? reject(error) : resolve())),
    );
  try {
    await (invocation ? invocation.writeSnapshotOutput(output, continuation, snapshot.exitCode) : write());
  } catch (error) {
    if (error instanceof WaitInvocationEnded) throw error;
    throw new WaitOutputError(
      error,
      invocation?.originalCommand ??
        `${waitCommandPrefix()} ${jobIds.join(' ')} --snapshot${opts.cursor === undefined ? '' : ` --cursor ${opts.cursor}`}${opts.lines === undefined ? '' : ` --lines ${opts.lines}`}${opts.executionSelection === undefined ? '' : ` --execution-selection '${opts.executionSelection.replaceAll("'", "'\\''")}'`}`,
    );
  }

  process.exitCode = snapshot.exitCode;
}

async function runStreamingWaitJobs(
  client: ReturnType<typeof makeClient>,
  jobIds: string[],
  projectRoot: string,
  opts: WaitJobsOptions,
): Promise<void> {
  process.exitCode = await followJobs({
    start: {
      kind: 'jobs',
      jobIds,
      executionSelections: parseExecutionSelections(opts.executionSelection, jobIds),
      ...(opts.cursor === undefined ? {} : { serializedCursor: opts.cursor }),
    },
    reconnectPolicy: opts.unbounded === true ? 'unbounded' : 'bounded',
    invocation: getWaitInvocation(),
    projectRoot,
    emitError,
    render: {
      ...getTerminalContext(),
      embed: opts.embed === true,
      verbose: opts.verbose === true,
    },
    connect: async ({ jobIds: activeJobIds, cursor, executionSelections, timeoutSeconds, signal, drainProgress }) => ({
      kind: 'subscription',
      subscription: await client.subscribeJobsWait(
        {
          jobIds: activeJobIds,
          timeoutSeconds,
          projectRoot,
          drainProgress,
          executionSelections,
          ...(cursor ? { cursor } : {}),
        },
        { signal },
      ),
    }),
  });
}

function parseExecutionSelections(
  value: string | undefined,
  jobIds: readonly string[],
): WaitExecutionSelection[] | undefined {
  if (value === undefined) return undefined;
  try {
    return waitExecutionSelectionsSchema.parse(JSON.parse(value));
  } catch {
    throw new UsageError(
      `--execution-selection must be the complete JSON state from a wait continuation. Rerun the printed continuation exactly as printed, or start a fresh wait: ${waitContinuationCommand(jobIds, null, 'bounded')}`,
    );
  }
}
