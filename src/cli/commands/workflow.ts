import type { Command } from 'commander';

import { UsageError } from '../errors.js';
import { makeClient, type WorkflowOptions } from '../dispatch.js';
import { emitError, handleLaunchResult } from '../emit.js';
import { resolveInput } from '../flags.js';

export function registerWorkflowCommands(program: Command): void {
  const workflowCommand = program.command('workflow');
  workflowCommand
    .description('Execute a workflow pipeline')
    .option('-e, --expression <expr>', 'Pipeline DSL expression')
    .option('-s, --start-prompt <text-or-file...>', 'Start prompt text or file path (multiple tokens are joined with spaces; a single existing path is read as a file)')
    .option('-c, --context <text-or-file...>', 'Shared context text or file path (multiple tokens are joined with spaces; a single existing path is read as a file)')
    .option('-p, --provider <name>', 'Provider name (registered provider)')
    .option('-w, --work-dir <path>', 'Working directory')
    .option('-o, --owner <id>', 'Session owner ID for memo isolation')
    .option('-d, --detach', 'Return launch decision without waiting')
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
        await handleLaunchResult(result, opts.detach, client);
      } catch (error) {
        emitError(error);
      }
    });
}
