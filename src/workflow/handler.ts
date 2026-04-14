import type { ProviderRegistry } from '../providers/registry.js';
import { isOwnerId } from '../shared/utils.js';
import type { LaunchDecision } from '../shared/types.js';
import type { CallerContext } from '../shared/request-context.js';
import { ZodError } from 'zod';
import { parseExpression } from './pipe-parser.js';
import { workflowInputSchema, type WorkflowInput } from './schemas.js';
import type { PipelineAST } from './types.js';

export class WorkflowInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowInputError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function isWorkflowInputFailure(error: unknown): error is WorkflowInputError | ZodError {
  return error instanceof WorkflowInputError || error instanceof ZodError;
}

interface WorkflowService {
  executeWorkflow(
    providerName: string,
    ast: PipelineAST,
    input: WorkflowInput,
    ctx: CallerContext,
    workDir?: string,
  ): Promise<LaunchDecision>;
}

function normalizeAst(ast: PipelineAST, defaultProviderName: string): PipelineAST {
  return ast.map((step) =>
    step.map((atom) => {
      const provider = atom.provider ?? defaultProviderName;

      if (atom.kind === 'prompt') {
        return {
          ...atom,
          provider,
        };
      }

      return {
        ...atom,
        namespace: atom.namespace ?? 'coral',
        provider,
      };
    }),
  );
}

function validateNamespaces(ast: PipelineAST): void {
  for (let stepIndex = 0; stepIndex < ast.length; stepIndex += 1) {
    for (const atom of ast[stepIndex]) {
      if (atom.kind !== 'agent' || atom.namespace === 'coral') continue;
      throw new Error(`Step ${stepIndex}, atom '${atom.agent}' has unsupported namespace '${atom.namespace}'`);
    }
  }
}

function validateParallelDuplicates(ast: PipelineAST): void {
  for (const step of ast) {
    const atomKeys = new Set<string>();
    for (const atom of step) {
      if (atom.kind !== 'agent') continue;
      const atomKey = `${atom.namespace}:${atom.agent}@${atom.provider}`;
      if (atomKeys.has(atomKey)) throw new Error(`Duplicate atom "${atomKey}" in parallel step`);
      atomKeys.add(atomKey);
    }
  }
}

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

function findUnknownProviders(ast: PipelineAST, defaultProviderName: string, providerRegistry: ProviderRegistry): string[] {
  const unknownProviders = new Set<string>();
  if (!providerRegistry.get(defaultProviderName)) {
    unknownProviders.add(defaultProviderName);
  }

  for (const step of ast) {
    for (const atom of step) {
      const providerName = atom.provider ?? defaultProviderName;
      if (!providerRegistry.get(providerName)) {
        unknownProviders.add(providerName);
      }
    }
  }

  return [...unknownProviders];
}

export async function handleWorkflow(
  rawArgs: Record<string, unknown>,
  executionSvc: WorkflowService,
  ctx: CallerContext,
  providerRegistry: ProviderRegistry,
): Promise<LaunchDecision> {
  const input = workflowInputSchema.parse(rawArgs);
  let ast: PipelineAST;
  try {
    ast = normalizeAst(parseExpression(input.expression), input.provider);
    validateNamespaces(ast);
    validateParallelDuplicates(ast);
  } catch (error: unknown) {
    throw new WorkflowInputError(error instanceof Error ? error.message : String(error));
  }

  const unknownProviders = findUnknownProviders(ast, input.provider, providerRegistry);
  if (unknownProviders.length > 0) {
    return unknownProviderDecision(unknownProviders);
  }

  const owner = isOwnerId(input.owner) ? input.owner : undefined;
  if (!owner) {
    return executionSvc.executeWorkflow(input.provider, ast, input, ctx, input.work_dir);
  }

  const effectiveContext = { ...ctx, coralEnv: { ...ctx.coralEnv, CORAL_OWNER: owner } };
  return executionSvc.executeWorkflow(input.provider, ast, input, effectiveContext, input.work_dir);
}
