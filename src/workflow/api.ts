import type { ProviderCatalog } from '../providers/catalog.js';
import type { CallerContext } from '../shared/request-context.js';
import type { WorkflowCommand } from '../shared/schemas.js';
import type { LaunchDecision } from '../shared/types.js';
import { isOwnerId } from '../shared/utils.js';
import { ZodError } from 'zod';
import type { PipelineAST } from './ast.js';
import { executePipeline } from './executor.js';
import { normalizeAst, validateNamespaces, validateParallelDuplicates, findUnknownProviders, WorkflowInputError } from './normalize.js';
import { parseExpression } from './parser.js';
import { readWorkflowProjection } from './projections.js';
import { resumeAll } from './recover.js';

function unknownProviderDecision(providers: string[]): LaunchDecision {
  const providerLabel = providers.join(', ');
  const isSingular = providers.length === 1;
  return {
    status: 'rejected',
    phase: 'preflight',
    code: 'unknown_provider',
    message: isSingular ? `Unknown provider: ${providerLabel}` : `Unknown providers: ${providerLabel}`,
  };
}

export function isWorkflowInputFailure(error: unknown): error is WorkflowInputError | ZodError {
  return error instanceof WorkflowInputError || error instanceof ZodError;
}

export type CompiledWorkflow = {
  providerName: string;
  ast: PipelineAST;
  input: WorkflowCommand;
  workDir?: string;
  owner?: string;
};

export const workflowQueries = {
  compile(command: WorkflowCommand, providerRegistry: ProviderCatalog): CompiledWorkflow | LaunchDecision {
    try {
      const ast = normalizeAst(parseExpression(command.expression), command.provider);
      validateNamespaces(ast);
      validateParallelDuplicates(ast);

      const unknownProviders = findUnknownProviders(ast, command.provider, providerRegistry);
      if (unknownProviders.length > 0) {
        return unknownProviderDecision(unknownProviders);
      }

      return {
        providerName: command.provider,
        ast,
        input: command,
        workDir: command.workDir,
        owner: isOwnerId(command.owner) ? command.owner : undefined,
      };
    } catch (error: unknown) {
      throw new WorkflowInputError(error instanceof Error ? error.message : String(error));
    }
  },
  readPlan: readWorkflowProjection,
} as const;

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
  run: executePipeline,
} as const;

export const workflowRecover = {
  resumeAll,
} as const;

export { WorkflowInputError };
