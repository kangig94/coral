import type { UpcasterRegistry } from '../store/envelope.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function registerWorkflowUpcasters(registry: UpcasterRegistry): void {
  registry.registerUpcaster('workflow.completed', 1, 2, (body) => {
    if (!isRecord(body)) {
      return body;
    }

    switch (body.kind) {
      case 'workflow_aborted':
        return { outcome: 'aborted' as const };
      case 'workflow_atom_failed':
        return { outcome: 'failed' as const };
      default:
        return body;
    }
  });
}
