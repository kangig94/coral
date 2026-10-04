import { UsageError, WaitOutputError } from './errors.js';
import { Command } from 'commander';
import { performance } from 'node:perf_hooks';
import { raceWithSignal } from '../infra/promise-signal.js';
import { isRecord } from '../infra/json.js';
import {
  WAIT_INVOCATION_CONTEXT_ENV,
  type WaitInvocationHandoff,
  type WaitInvocationMode,
} from '../infra/wait-invocation-context.js';

const WAIT_BUDGET_MS = 590_000;
const WAIT_CLEANUP_MS = 10_000;
const SNAPSHOT_BUDGET_MS = 30_000;
const SNAPSHOT_CLEANUP_MS = 1_000;

let currentInvocation: WaitInvocation | undefined;

export class WaitInvocationEnded extends Error {
  constructor() {
    super('Wait invocation ended');
  }
}

function commandText(args: readonly string[]): string {
  return ['coral-cli', ...args]
    .map((arg) => (/^[A-Za-z0-9_./,:=+-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`))
    .join(' ');
}

export function waitInvocationMode(program: Command, argv: readonly string[]): WaitInvocationMode | undefined {
  const wait = program.commands.find((command) => command.name() === 'wait');
  const jobs = wait?.commands.find((command) => command.name() === 'jobs');
  if (wait === undefined || jobs === undefined) return undefined;
  const fail = () => {
    throw new Error('Invalid monitor invocation');
  };
  const parser = new Command().exitOverride(fail).configureOutput({ writeOut: () => {}, writeErr: () => {} });
  const waitParser = parser.command(wait.name()).aliases(wait.aliases());
  const jobsParser = waitParser.command(jobs.name()).aliases(jobs.aliases()).argument('<jobIds...>');
  for (const [source, target] of [
    [program, parser],
    [wait, waitParser],
    [jobs, jobsParser],
  ] as const) {
    for (const option of source.options) target.addOption(option);
  }
  let mode: WaitInvocationMode | undefined;
  jobsParser.action(() => {
    validateWaitJobsOptions(jobsParser.opts());
    mode = jobsParser.opts().now === true ? 'snapshot' : 'bounded';
  });
  try {
    parser.parse([...argv]);
  } catch (error) {
    if (error instanceof UsageError) throw error;
    return undefined;
  }
  return mode;
}

export class WaitInvocation implements WaitInvocationHandoff {
  readonly signal: AbortSignal;
  readonly mode: WaitInvocationMode;
  readonly originalCommand: string;
  private readonly controller = new AbortController();
  private readonly deadline: number;
  private readonly hardDeadline: number;
  private readonly watchdog: NodeJS.Timeout;
  private readonly backstop: NodeJS.Timeout;
  private continuation: string | undefined;
  private continuationFlushed = false;
  private readonly delegated: boolean;
  private readonly onSigint = () => this.stop();
  private readonly onMessage = (message: unknown) => {
    if (isRecord(message) && message.type === 'wait-cancel') this.stop();
  };

  constructor(mode: WaitInvocationMode, argv: readonly string[]) {
    this.mode = mode;
    this.signal = this.controller.signal;
    this.originalCommand = commandText(argv.slice(2));
    const inherited = process.env[WAIT_INVOCATION_CONTEXT_ENV];
    delete process.env[WAIT_INVOCATION_CONTEXT_ENV];
    this.delegated =
      inherited !== undefined && process.env.CORAL_CLI_HANDOFF_DELEGATED === '1' && process.send !== undefined;
    let budget = mode === 'snapshot' ? SNAPSHOT_BUDGET_MS : WAIT_BUDGET_MS;
    let cleanup = mode === 'snapshot' ? SNAPSHOT_CLEANUP_MS : WAIT_CLEANUP_MS;
    if (this.delegated) {
      try {
        const context: unknown = JSON.parse(inherited ?? '');
        if (
          !isRecord(context) ||
          context.mode !== mode ||
          typeof context.remainingMs !== 'number' ||
          !Number.isFinite(context.remainingMs) ||
          context.remainingMs < 0 ||
          typeof context.cleanupMs !== 'number' ||
          !Number.isFinite(context.cleanupMs) ||
          context.cleanupMs < 0
        )
          throw new Error('Invalid delegated wait budget');
        budget = Math.min(budget, context.remainingMs);
        cleanup = Math.min(cleanup, context.cleanupMs);
      } catch {
        budget = 0;
        cleanup = 0;
      }
      process.on('message', this.onMessage);
    }
    const start = performance.now();
    this.deadline = start + budget;
    this.hardDeadline = this.deadline + cleanup;
    this.watchdog = setTimeout(() => this.stop(), budget);
    this.watchdog.unref();
    this.backstop = setTimeout(() => {
      this.stop();
      this.flushContinuation();
      process.exit(75);
    }, budget + cleanup);
    this.backstop.unref();
    process.on('SIGINT', this.onSigint);
  }

  remainingMs(): number {
    return Math.max(0, this.deadline - performance.now());
  }
  cleanupRemainingMs(): number {
    return Math.max(0, this.hardDeadline - performance.now());
  }
  stop(): void {
    if (!this.signal.aborted) this.controller.abort();
  }

  saveContinuation(text: string, complete = false): void {
    if (this.signal.aborted) return;
    this.continuation = text;
    this.continuationFlushed ||= complete;
    if (this.delegated && process.connected)
      process.send?.({ type: 'wait-delivery', continuation: text, complete }, () => {});
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    this.check();
    return raceWithSignal(work(), this.signal, () => {
      throw new WaitInvocationEnded();
    });
  }

  check(): void {
    if (this.remainingMs() === 0) this.stop();
    if (this.signal.aborted) throw new WaitInvocationEnded();
  }

  async flushOutput(): Promise<void> {
    await this.run(
      () =>
        new Promise<void>((resolve, reject) => {
          process.stdout.write('', (error) => {
            if (error) reject(new WaitOutputError(error, this.originalCommand));
            else resolve();
          });
        }),
    );
  }

  flushContinuation(): void {
    if (this.continuationFlushed || this.delegated) return;
    this.continuationFlushed = true;
    process.exitCode = 75;
    process.stdout.write(
      this.continuation ??
        `${this.mode === 'snapshot' ? 'coordinator not ready; snapshot admission did not complete.' : 'Wait admission did not complete; monitoring ended.'}\nRun ${this.originalCommand}\n`,
    );
  }

  dispose(force = false): void {
    clearTimeout(this.watchdog);
    if (this.signal.aborted && !force) return;
    clearTimeout(this.backstop);
    process.off('SIGINT', this.onSigint);
    process.off('message', this.onMessage);
  }
}

export function getWaitInvocation(): WaitInvocation | undefined {
  return currentInvocation;
}

export function installWaitInvocation(invocation: WaitInvocation | undefined): void {
  currentInvocation = invocation;
}

export function validateWaitJobsOptions(opts: {
  now?: boolean;
  lines?: string;
  cursor?: string;
  embed?: boolean;
  verbose?: boolean;
}): number | undefined {
  if (opts.now && (opts.embed || opts.verbose))
    throw new UsageError(
      `--now cannot be used with --embed or --verbose. Remove ${[opts.embed ? '--embed' : '', opts.verbose ? '--verbose' : ''].filter(Boolean).join(' and ')} for an immediate snapshot, or remove --now for a streaming wait. Use coral-cli jobs detail <jobId> --full for full content.`,
    );
  if (opts.lines !== undefined && opts.cursor !== undefined)
    throw new UsageError(
      '--lines cannot be used with --cursor. Remove --lines to resume from that cursor, or remove --cursor to show the most recent lines.',
    );
  if (opts.lines !== undefined && opts.now !== true)
    throw new UsageError(
      '--lines requires --now. Add --now for an immediate snapshot of recent lines, or remove --lines for a streaming wait.',
    );
  const lines = opts.lines === undefined ? undefined : Number(opts.lines);
  if (lines !== undefined && (!Number.isInteger(lines) || lines < 1 || lines > 500))
    throw new UsageError(
      '--lines must be an integer from 1 to 500. Choose a value in that range, or remove --lines to use the default 20.',
    );
  return lines;
}
