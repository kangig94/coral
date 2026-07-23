import { ZodError } from 'zod';

import type { ProviderCatalog } from '../providers/catalog.js';
import type { RejectedLaunchDecision } from '../jobs/launch.js';
import { errorMessage } from '../infra/error-format.js';
import { isOwnerId } from '../infra/identifiers.js';
import type { PipelineAST } from './ast.js';
import type { WorkflowCommand } from './input.js';
import {
  normalizeAst,
  validateNamespaces,
  validateParallelDuplicates,
  findUnknownProviders,
  WorkflowInputError,
} from './normalize.js';
import { parseExpression } from './parser.js';
import { readWorkflowProjection } from './read-queries.js';

function unknownProviderDecision(providers: string[]): RejectedLaunchDecision {
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
  compile(command: WorkflowCommand, providerRegistry: ProviderCatalog): CompiledWorkflow | RejectedLaunchDecision {
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
      throw new WorkflowInputError(errorMessage(error));
    }
  },
  readPlan: readWorkflowProjection,
} as const;
