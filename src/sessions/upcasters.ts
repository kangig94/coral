import { createHash } from 'node:crypto';
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
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    return join(baseDir, 'legacy');
  }

  return join(baseDir, createHash('sha1').update(sessionId).digest('hex').slice(0, 12));
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
