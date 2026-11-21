import { Option, type Command } from 'commander';

import { normalizeUsageError, UsageError } from '../errors.js';
import { makeClient, type WorkflowOptions } from '../dispatch.js';
import { emitError, emitLaunchResult } from '../emit.js';
import { resolveInput } from '../flags.js';

export function registerWorkflowCommands(program: Command): void {
  const workflowCommand = program.command('workflow');
  workflowCommand
    .description('Execute a workflow; binds every provider profile referenced by the workflow for its full lifetime')
    .option('-e, --expression <expr>', 'Pipeline DSL expression')
    .option(
      '-s, --start-prompt <text-or-file...>',
      'Start prompt input (tokens are joined with single spaces; the whole input is read if it names an existing regular file, or stdin if exactly -; otherwise literal text)',
    )
    .option(
      '-c, --context <text-or-file...>',
      'Shared context input (tokens are joined with single spaces; the whole input is read if it names an existing regular file, or stdin if exactly -; otherwise literal text)',
    )
    .option('-p, --provider <name>', 'Provider name (registered provider)')
    .option('-w, --work-dir <path>', 'Working directory')
    .addOption(new Option('-o, --owner <id>').hideHelp())
    .addHelpText(
      'after',
      '\nReturns after the launch decision and prints a wait command for an accepted job.\n' +
        'To abort the job, run coral-cli jobs abort <id>.\n',
    )
    .action(async (opts: WorkflowOptions) => {
      try {
        const { expression } = opts;

        if (expression === undefined) {
          throw new UsageError('expression is required (-e, --expression)');
        }
        if (opts.startPrompt === undefined) {
          throw new UsageError('start prompt is required (-s, --start-prompt)');
        }

        const payload = {
          ...(opts.context !== undefined ? { context: resolveInput(opts.context) } : {}),
          ...(opts.provider !== undefined ? { provider: opts.provider } : {}),
          ...(opts.workDir !== undefined ? { workDir: opts.workDir } : {}),
          ...(opts.owner !== undefined ? { owner: opts.owner } : {}),
          startPrompt: resolveInput(opts.startPrompt),
        };

        const client = makeClient(process.cwd(), workflowCommand);
        const result = await client.workflow(expression, payload);
        emitLaunchResult(result);
      } catch (error) {
        emitError(normalizeUsageError(error));
      }
    });
}
