import type { ProviderCatalog } from '../providers/catalog.js';
import type { PipelineAST } from './ast.js';

export class WorkflowInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowInputError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function normalizeAst(ast: PipelineAST, defaultProviderName: string): PipelineAST {
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

export function validateNamespaces(ast: PipelineAST): void {
  for (let stepIndex = 0; stepIndex < ast.length; stepIndex += 1) {
    for (const atom of ast[stepIndex]) {
      if (atom.kind !== 'agent' || atom.namespace === 'coral') continue;
      throw new Error(`Step ${stepIndex}, atom '${atom.agent}' has unsupported namespace '${atom.namespace}'`);
    }
  }
}

export function validateParallelDuplicates(ast: PipelineAST): void {
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

export function findUnknownProviders(
  ast: PipelineAST,
  defaultProviderName: string,
  providerRegistry: ProviderCatalog,
): string[] {
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
