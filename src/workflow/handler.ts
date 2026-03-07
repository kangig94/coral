import { registerBuiltInProviders } from '../providers/bootstrap.js';
import { getNewProvider } from '../providers/registry.js';
import type { LaunchDecision } from '../types.js';
import type { CallerContext } from '../execution/service.js';
import { parseExpression } from './pipe-parser.js';
import { workflowInputSchema } from './schemas.js';
import type { PipelineAST } from './types.js';

type WorkflowService = Pick<import('../execution/service.js').ExecutionService, 'executeWorkflow'>;

function validateAtomConfigKeys(atoms: Record<string, Record<string, unknown>>, ast: PipelineAST): void {
  const atomNames = new Set<string>();
  for (const step of ast) {
    for (const atom of step) {
      if (atom.kind !== 'agent') continue;
      atomNames.add(atom.agent);
    }
  }

  const unknownKeys = Object.keys(atoms).filter((key) => !atomNames.has(key));
  if (unknownKeys.length === 0) return;
  throw new Error(`Unknown atoms keys: ${unknownKeys.join(', ')}`);
}

function normalizeAst(ast: PipelineAST, defaultProviderName: string): PipelineAST {
  return ast.map((step) => step.map((atom) => {
    if (atom.kind === 'prompt') {
      return {
        ...atom,
        provider: atom.provider ?? defaultProviderName,
      };
    }

    return {
      ...atom,
      namespace: atom.namespace ?? 'coral',
      provider: atom.provider ?? defaultProviderName,
    };
  }));
}

function validateNamespaces(ast: PipelineAST): void {
  for (let stepIndex = 0; stepIndex < ast.length; stepIndex += 1) {
    for (const atom of ast[stepIndex]) {
      if (atom.kind !== 'agent' || atom.namespace === 'coral') continue;
      throw new Error(
        `Step ${stepIndex + 1}, atom '${atom.agent}' has unsupported namespace '${atom.namespace}'`,
      );
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

function findUnknownProviders(ast: PipelineAST, defaultProviderName: string): string[] {
  registerBuiltInProviders();

  const unknownProviders = new Set<string>();
  if (!getNewProvider(defaultProviderName)) {
    unknownProviders.add(defaultProviderName);
  }

  for (const step of ast) {
    for (const atom of step) {
      const providerName = atom.provider ?? defaultProviderName;
      if (!getNewProvider(providerName)) {
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
): Promise<LaunchDecision> {
  const input = workflowInputSchema.parse(rawArgs);
  const ast = normalizeAst(parseExpression(input.expression), input.provider);

  if (input.atoms) validateAtomConfigKeys(input.atoms, ast);
  validateNamespaces(ast);
  validateParallelDuplicates(ast);

  const unknownProviders = findUnknownProviders(ast, input.provider);
  if (unknownProviders.length > 0) {
    return unknownProviderDecision(unknownProviders);
  }

  const effectiveCtx = input.work_dir
    ? { ...ctx, projectRoot: input.work_dir }
    : ctx;

  return executionSvc.executeWorkflow(input.provider, ast, input, effectiveCtx);
}
