import { appendProgressEvent } from '../runner/progress.js';
import {
  launchJob as launchRunnerJob,
} from '../runner/job-manager.js';
import type { SessionManager } from '../runner/session-manager.js';
import type { SessionProvider } from '../runner/types.js';
import { type McpResult, textResult } from '../shared/mcp-utils.js';
import { executePipeline, type AtomDispatchFn } from './pipe-executor.js';
import { parseExpression } from './pipe-parser.js';
import { workflowInputSchema } from './schemas.js';
import type { PipelineAST } from './types.js';

type NotifyFn = (n: { method: string; params: Record<string, unknown> }) => Promise<void>;

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

function validateNamespaces(ast: PipelineAST): void {
  for (let stepIndex = 0; stepIndex < ast.length; stepIndex += 1) {
    const step = ast[stepIndex];
    for (const atom of step) {
      const namespace = atom.namespace ?? 'coral';
      if (namespace !== 'coral') {
        throw new Error(`Step ${stepIndex + 1}, atom '${atom.agent}' has unsupported namespace '${namespace}'`);
      }
    }
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
  if (input.args) validateArgsKeys(input.args, ast);
  validateNamespaces(ast);

  return launchRunnerJob({
    provider: input.provider,
    sessionLabel: `workflow-${Date.now()}`,
    workingDirectory: process.cwd(),
    handler: async (signal, onEvent) => {
      const dispatch: AtomDispatchFn = (name, args) => toolCallFn(name, args, sessionManager, progressToken, notify);
      const output = await executePipeline(ast, input.prompt, input.provider, dispatch, {
        args: input.args,
        signal,
        onProgress: (message) => onEvent(message),
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
