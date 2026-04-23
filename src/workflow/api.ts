import { z, ZodError } from 'zod';
import type { ProviderCatalog } from '../providers/catalog.js';
import type { CallerContext } from '../infra/request-context.js';
import type { LaunchDecision } from '../jobs/launch.js';
import { identPattern, providerIdentPattern } from '../infra/identifiers.js';
import { isOwnerId } from '../infra/owner-id.js';
import type { PipelineAST } from './ast.js';
import { executePipeline } from './executor.js';
import { normalizeAst, validateNamespaces, validateParallelDuplicates, findUnknownProviders, WorkflowInputError } from './normalize.js';
import { parseExpression } from './parser.js';
import { readWorkflowProjection } from './projections.js';
import { resumeAll } from './recover.js';

const modelNameSchema = z
  .string()
  .regex(identPattern, 'Model name must be alphanumeric with dots, hyphens, or underscores');
const projectRootSchema = z.string().min(1, 'Project root is required');
const ownerSchema = z.string().regex(identPattern, 'Owner must be token-safe');
const providerNameSchema = z
  .string()
  .regex(providerIdentPattern, 'Provider name must be lowercase letters, digits, or hyphens');
const claudeModelCapSchema = modelNameSchema.optional();

export const workflowCommandSchema = z
  .object({
    expression: z.string().min(1, 'Expression required'),
    startPrompt: z.string().min(1, 'Prompt required'),
    context: z.string().optional(),
    provider: providerNameSchema.default('claude'),
    workDir: z.string().optional(),
    owner: ownerSchema.optional(),
  })
  .strict();

export type WorkflowCommand = z.infer<typeof workflowCommandSchema>;

export const workflowRequestSchema = workflowCommandSchema
  .extend({
    projectRoot: projectRootSchema,
    claudeModelCap: claudeModelCapSchema,
  })
  .strict();

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

export const workflowCompiler = {
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
} as const;

export { executePipeline };

export const workflowRecover = {
  resumeAll,
} as const;

export { WorkflowInputError };
export { WorkflowExecutionError } from './command.js';
export { createWorkflowJournal, readWorkflowProjection } from './projections.js';
export type { LaunchDecision } from '../jobs/launch.js';
export type { PipelineAST } from './ast.js';
export type {
  PipelineResult,
  StepDetail,
  WorkflowSessionHandle,
} from './command.js';
