import { registerBuiltInProviders } from '../providers/bootstrap.js';
import { getAllTools, getProviderNames } from '../providers/registry.js';

const waitTool = {
  name: 'wait',
  description: 'Wait for session completion. Monitors one or more sessions (from any provider) and returns when the first completes.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      sessions: { type: 'array', items: { type: 'string' }, description: 'Session UUIDs to monitor (from exec/fork response)' },
      timeout_seconds: { type: 'number', description: 'Max wait time in seconds (1-1200, default 600)' },
      poll_ms: { type: 'number', description: 'Poll interval in ms (50-5000, default from CORAL_WAIT_POLL_MS or 500)' },
    },
    required: ['sessions'],
  },
};

const abortTool = {
  name: 'abort',
  description: 'Abort active sessions. Provider-agnostic — works for codex, claude, and workflow sessions.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      sessions: {
        type: 'array',
        items: { type: 'string', format: 'uuid' },
        minItems: 1,
        description: 'Session UUIDs to abort',
      },
    },
    required: ['sessions'],
  },
};

function workflowProviderSchema(): Record<string, unknown> {
  const baseSchema = { type: 'string', description: 'Default provider for atoms without @ override' };
  const providers = getProviderNames();
  if (providers.length === 0) return baseSchema;
  return { ...baseSchema, enum: providers };
}

function workflowTool() {
  return {
    name: 'workflow',
    description: 'Execute a deterministic multi-agent pipeline. DSL: "(architect, critic) -> resolver". Use @provider for per-atom provider override and atoms for per-atom config.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        expression: { type: 'string', description: 'Pipeline expression: "(a, b) -> c" or "a -> b -> c"' },
        prompt: { type: 'string', description: 'Initial prompt for the first pipeline step' },
        provider: workflowProviderSchema(),
        atoms: { type: 'object', description: 'Per-atom config: { atomName: { effort?, instruction? } }' },
        stale_timeout_seconds: { type: 'number', description: 'Seconds of inactivity before stale atom recovery triggers (0 disables, default: 900)' },
      },
      required: ['expression', 'prompt'],
    },
  };
}

export function getTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  registerBuiltInProviders();
  return [...getAllTools(), waitTool, abortTool, workflowTool()];
}
