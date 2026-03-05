import { appendProgressEvent } from '../runner/progress.js';
import {
  launchJob as launchRunnerJob,
  activeSessions,
} from '../runner/job-manager.js';
import { registerBuiltInProviders } from '../providers/bootstrap.js';
import { getProvider, getProviderNames } from '../providers/registry.js';
import type { SessionManager } from '../runner/session-manager.js';
import type { SessionProvider } from '../runner/types.js';
import type { NotifyFn } from '../providers/types.js';
import { type McpResult, textResult } from '../shared/mcp-utils.js';
import { executePipeline, type AtomDispatchFn } from './pipe-executor.js';
import { parseExpression } from './pipe-parser.js';
import { workflowInputSchema } from './schemas.js';
import type { PipelineAST } from './types.js';

type ToolCallFn = (
  name: SessionProvider,
  args: Record<string, unknown>,
  sessionManager: SessionManager,
  progressToken?: string | number,
  notify?: NotifyFn,
) => Promise<McpResult>;

function collectAtomNames(ast: PipelineAST): Set<string> {
  const names = new Set<string>();
  for (const step of ast) {
    for (const atom of step) {
      if (atom.kind !== 'agent') continue;
      names.add(atom.agent);
    }
  }
  return names;
}

function validateArgsKeys(args: Record<string, Record<string, unknown>>, ast: PipelineAST): void {
  const atomNames = collectAtomNames(ast);
  const unknownKeys = Object.keys(args).filter((key) => !atomNames.has(key));
  if (unknownKeys.length > 0) {
    throw new Error(`Unknown args keys: ${unknownKeys.join(', ')}`);
  }
}

function normalizeAst(ast: PipelineAST, defaultProvider: SessionProvider): PipelineAST {
  return ast.map((step) => step.map((atom) => {
    if (atom.kind === 'prompt') {
      return {
        ...atom,
        provider: atom.provider ?? defaultProvider,
      };
    }
    return {
      ...atom,
      namespace: atom.namespace ?? 'coral',
      provider: atom.provider ?? defaultProvider,
    };
  }));
}

function validateNamespaces(ast: PipelineAST): void {
  for (let stepIndex = 0; stepIndex < ast.length; stepIndex += 1) {
    const step = ast[stepIndex];
    for (const atom of step) {
      if (atom.kind !== 'agent') continue;
      if (atom.namespace !== 'coral') {
        throw new Error(
          `Step ${stepIndex + 1}, atom '${atom.agent}' has unsupported namespace '${atom.namespace}'`,
        );
      }
    }
  }
}

function validateParallelDuplicates(ast: PipelineAST): void {
  for (const step of ast) {
    const atomKeys = new Set<string>();
    for (const atom of step) {
      if (atom.kind !== 'agent') continue;
      const atomKey = `${atom.namespace}:${atom.agent}@${atom.provider}`;
      if (atomKeys.has(atomKey)) {
        throw new Error(`Duplicate atom "${atomKey}" in parallel step`);
      }
      atomKeys.add(atomKey);
    }
  }
}

function validateRegisteredProviders(ast: PipelineAST, defaultProvider: SessionProvider): void {
  registerBuiltInProviders();
  const providerNames = getProviderNames();
  if (providerNames.length === 0) return;

  const unknownProviders = new Set<string>();
  if (!getProvider(defaultProvider)) unknownProviders.add(defaultProvider);

  for (const step of ast) {
    for (const atom of step) {
      const provider = atom.provider ?? defaultProvider;
      if (!getProvider(provider)) unknownProviders.add(provider);
    }
  }

  if (unknownProviders.size === 1) {
    throw new Error(`Unknown provider "${[...unknownProviders][0]}"`);
  }
  if (unknownProviders.size > 1) {
    throw new Error(`Unknown providers: ${[...unknownProviders].join(', ')}`);
  }
}

export function handleWorkflow(
  rawArgs: Record<string, unknown>,
  toolCallFn: ToolCallFn,
  sessionManager: SessionManager,
  progressToken?: string | number,
  notify?: NotifyFn,
): McpResult {
  const input = workflowInputSchema.parse(rawArgs);
  const ast = parseExpression(input.expression);
  const normalized = normalizeAst(ast, input.provider);
  if (input.args) validateArgsKeys(input.args, normalized);
  validateNamespaces(normalized);
  validateParallelDuplicates(normalized);
  validateRegisteredProviders(normalized, input.provider);

  return launchRunnerJob({
    provider: input.provider,
    sessionLabel: `workflow-${Date.now()}`,
    workingDirectory: process.cwd(),
    handler: async (signal, onEvent) => {
      const dispatch: AtomDispatchFn = (name, args) => toolCallFn(name, args, sessionManager, progressToken, notify);
      const output = await executePipeline(normalized, input.prompt, input.provider, dispatch, {
        args: input.args,
        signal,
        onProgress: (message) => onEvent(message),
        staleTimeoutMs: input.stale_timeout_seconds * 1000,
        abortSession: (id) => {
          const entry = activeSessions.get(id);
          if (entry) entry.controller.abort();
        },
      });
      return textResult(output);
    },
    mgr: sessionManager,
    makeOnEvent: ({ progressFile }) => (line) => appendProgressEvent(progressFile, 'pipeline', line),
    extractCompletion: (result) => ({
      responseText: result.content[0]?.text ?? '',
      metadata: {},
    }),
  });
}
