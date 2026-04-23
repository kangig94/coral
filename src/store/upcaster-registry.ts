import { z } from 'zod';

import { CoralSetupError } from '../runtime/errors.js';

type Upcaster = (body: unknown) => unknown;

interface UpcasterRecord {
  toVersion: number;
  fn: Upcaster;
}

export class UpcasterRegistry {
  private readonly entries = new Map<string, UpcasterRecord>();

  registerUpcaster(type: string, fromVersion: number, toVersion: number, fn: Upcaster): void {
    const key = `${type}|${fromVersion}`;
    if (this.entries.has(key)) {
      throw new CoralSetupError({
        code: 'upcaster_conflict',
        userMessage: `Upcaster already registered for type '${type}' from v${fromVersion}`,
        remediation: 'Remove the duplicate registerUpcaster call or use a different fromVersion.',
        context: { type, fromVersion },
      });
    }
    this.entries.set(key, { toVersion, fn });
  }

  parseBody<T>(type: string, bodyVersion: number, body: unknown, currentSchema: z.ZodType<T>): T {
    let current = body;
    let version = bodyVersion;
    const visited = new Set<number>([version]);

    while (true) {
      const rec = this.entries.get(`${type}|${version}`);
      if (!rec) {
        const parsed = currentSchema.safeParse(current);
        if (parsed.success) {
          return parsed.data;
        }

        throw new CoralSetupError({
          code: 'upcaster_missing',
          userMessage: `No upcaster chain from v${bodyVersion} to current for type '${type}'`,
          remediation: 'Register upcasters to bridge the gap, or verify bodyVersion.',
          context: { type, bodyVersion, stoppedAt: version, error: parsed.error.format() },
        });
      }

      current = rec.fn(current);
      version = rec.toVersion;
      if (visited.has(version)) {
        throw new CoralSetupError({
          code: 'upcaster_cycle',
          userMessage: `Upcaster chain cycle detected for type '${type}' at v${version}`,
          remediation: 'Inspect registerUpcaster calls for this type; a cycle makes the chain non-terminating.',
          context: { type, bodyVersion, cycleAt: version, chain: [...visited] },
        });
      }
      visited.add(version);
    }
  }
}

export function createEmptyRegistry(): UpcasterRegistry {
  return new UpcasterRegistry();
}
