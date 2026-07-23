import type { InvocationContext } from '../runtime/invocation-context.js';
import type { WorkflowLaunchDecision } from '../jobs/launch.js';
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
        ctx: InvocationContext,
        workDir?: string,
      ): Promise<WorkflowLaunchDecision>;
    },
    compiled: CompiledWorkflow,
    ctx: InvocationContext,
  ): Promise<WorkflowLaunchDecision> {
    const effectiveCtx =
      compiled.owner === undefined ? ctx : { ...ctx, coralEnv: { ...ctx.coralEnv, CORAL_OWNER: compiled.owner } };
    return service.executeWorkflow(compiled.providerName, compiled.ast, compiled.input, effectiveCtx, compiled.workDir);
  },
} as const;
