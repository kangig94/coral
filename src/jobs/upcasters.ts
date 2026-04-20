import type { UpcasterRegistry } from '../store/envelope.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function registerJobsUpcasters(registry: UpcasterRegistry): void {
  registry.registerUpcaster('job.launch.requested', 1, 2, (body) => {
    if (!isRecord(body)) {
      return body;
    }

    return {
      ...body,
      ...(body.jobKind === undefined ? { jobKind: 'provider' as const } : {}),
    };
  });
}
