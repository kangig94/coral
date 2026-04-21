import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { sessionBase } from '../infra/paths.js';
import {
  ADAPTER_OUTPUT_UNPARSEABLE_KIND,
  PROVIDER_REQUEST_FAILED_KIND,
  PROVIDER_SESSION_UNAVAILABLE_KIND,
} from '../providers/fault.js';
import type { UpcasterRegistry } from '../store/envelope.js';

type SessionOpenedBodyV1 = {
  controller: string;
  provider: string;
  sessionId?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

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

  registry.registerUpcaster('session.interrupted', 1, 2, (body) => {
    if (!isRecord(body) || body.kind !== 'app_server_interrupted') {
      return body;
    }

    return {
      trigger: body.trigger,
      continuity: body.continuity,
    };
  });

  registry.registerUpcaster('session.provider_failed', 1, 2, (body) => {
    if (!isRecord(body)) {
      return body;
    }

    switch (body.kind) {
      case PROVIDER_SESSION_UNAVAILABLE_KIND:
        return {
          provider: body.provider,
          reason: 'session_unavailable',
          message: body.note,
        };
      case PROVIDER_REQUEST_FAILED_KIND:
        return {
          provider: body.provider,
          reason: 'request_failed',
          message: body.message,
        };
      default:
        return body;
    }
  });

  registry.registerUpcaster('session.adapter_unparseable', 1, 2, (body) => {
    if (!isRecord(body) || body.kind !== ADAPTER_OUTPUT_UNPARSEABLE_KIND) {
      return body;
    }

    return {
      provider: body.provider,
      exitCode: body.exitCode,
      stdout: body.stdout,
      stderr: body.stderr,
      parseError: body.parseError,
    };
  });
}
