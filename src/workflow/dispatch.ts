import type { CallerContext } from '../transport/request-context.js';
import type { LaunchDecision } from '../jobs/launch.js';
import type { PipelineAST } from './ast.js';
import type { CompiledWorkflow } from './compile.js';
import type { WorkflowCommand } from './input.js';

export const workflowCommands = {
  execute(
    service: {
      executeWorkflow(
        providerName: string,
        ast: PipelineAST,
        input: WorkflowCommand,
        ctx: CallerContext,
        workDir?: string,
      ): Promise<LaunchDecision>;
    },
    compiled: CompiledWorkflow,
    ctx: CallerContext,
  ): Promise<LaunchDecision> {
    const effectiveCtx =
      compiled.owner === undefined ? ctx : { ...ctx, coralEnv: { ...ctx.coralEnv, CORAL_OWNER: compiled.owner } };
    return service.executeWorkflow(compiled.providerName, compiled.ast, compiled.input, effectiveCtx, compiled.workDir);
  },
} as const;
