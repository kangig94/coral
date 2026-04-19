import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { sessionBase } from '../infra/paths.js';
import type { UpcasterRegistry } from '../store/envelope.js';

type SessionOpenedBodyV1 = {
  controller: string;
  provider: string;
  sessionId?: string;
};

function deriveLegacySessionShardDir(sessionId?: string): string {
  const baseDir = sessionBase();

  if (typeof sessionId === 'string' && sessionId.length > 0) {
    try {
      for (const entry of readdirSync(baseDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) {
          continue;
        }

        const shardDir = join(baseDir, entry.name);
        if (existsSync(join(shardDir, `${sessionId}.json`))) {
          return shardDir;
        }
      }
    } catch {
      // best effort
    }
  }

  return join(baseDir, 'legacy');
}

export function registerSessionsUpcasters(registry: UpcasterRegistry): void {
  registry.registerUpcaster('session.opened', 1, 2, (body) => {
    const legacy = body as SessionOpenedBodyV1;
    return {
      controller: legacy.controller,
      provider: legacy.provider,
      shard_dir: deriveLegacySessionShardDir(legacy.sessionId),
    };
  });
}
