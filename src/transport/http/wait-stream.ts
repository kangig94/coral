declare const __PLUGIN_ROOT__: string;

import { BackendToolHttpError } from './client-errors.js';
import { readBackendInfo } from '../../infra/backend-discovery.js';
import { BackendUnreachableError, TransientHttpError } from '../../infra/http-errors.js';
import { isRecord } from '../../infra/json.js';
import { readBuildFlavor } from '../../infra/bridge-manifest.js';
import { HEALTH_TIMEOUT_MS } from '../../transport/http/sse.js';
import type { WaitStreamEvent } from '../../jobs/wait.js';
import { parseSerializedWaitCursor, serializeWaitCursor } from '../../jobs/wait.js';
import { createIpcClient } from '../ipc/client.js';
import { throwBackendCommunicationError } from './backend-communication.js';

export type WaitCursorRef = { lastEventId?: string };

function resolvePluginRoot(): string {
  if (typeof __PLUGIN_ROOT__ === 'string') {
    return __PLUGIN_ROOT__;
  }
  if (typeof process.env.CLAUDE_PLUGIN_ROOT === 'string' && process.env.CLAUDE_PLUGIN_ROOT.length > 0) {
    return process.env.CLAUDE_PLUGIN_ROOT;
  }
  return process.cwd();
}

function waitSubscriptionStatusCode(body: Record<string, unknown>): number {
  switch (body.code) {
    case 'scope_mismatch':
      return 403;
    case 'jobs_not_found':
      return 404;
    case 'backend_recovering':
    case 'backend_shutting_down':
      return 503;
    default:
      return 400;
  }
}

function mapWaitSubscriptionError(error: unknown): unknown {
  if (!(error instanceof Error) || !isRecord(error.cause) || typeof error.cause.message !== 'string') {
    return error;
  }

  if (error.cause.code === 'backend_recovering' || error.cause.code === 'backend_shutting_down') {
    return new TransientHttpError(503, error.cause.message);
  }

  return new BackendToolHttpError(
    error.cause.message,
    waitSubscriptionStatusCode(error.cause),
    error.cause,
  );
}

export async function* streamWait(
  jobIds: string[],
  timeoutSeconds: number | undefined,
  backendInfo: { host: string; port: number; token: string; socketPath?: string },
  lastEventId?: string,
  signal?: AbortSignal,
  projectRoot?: string,
  cursorRef?: WaitCursorRef,
): AsyncGenerator<WaitStreamEvent> {
  const inputCursor = parseSerializedWaitCursor(lastEventId);
  if (lastEventId && !inputCursor) {
    throw new BackendToolHttpError('Invalid Last-Event-ID cursor', 400, {
      code: 'invalid_request',
      message: 'Invalid Last-Event-ID cursor',
    });
  }

  try {
    const pluginRoot = resolvePluginRoot();
    const socketPath = backendInfo.socketPath ?? readBackendInfo(pluginRoot)?.socketPath;
    if (!socketPath) {
      throw new BackendUnreachableError(
        `Coral coordinator IPC discovery is unavailable for ${readBuildFlavor(pluginRoot)} mode.`,
      );
    }

    const client = createIpcClient(socketPath);
    const subscription = await client.subscribe<WaitStreamEvent>(
      'jobs.wait',
      {
        jobIds,
        timeoutSeconds,
        projectRoot,
        ...(inputCursor ? { cursor: inputCursor } : {}),
      },
      {
        timeoutMs: HEALTH_TIMEOUT_MS,
        signal,
      },
    );

    try {
      const currentCursor = { jobs: { ...(inputCursor?.jobs ?? {}) } };
      for await (const event of subscription) {
        if (event.type === 'progress') {
          currentCursor.jobs[event.jobId] = event.eventId;
          if (cursorRef) {
            cursorRef.lastEventId = serializeWaitCursor(currentCursor);
          }
        } else if (event.type === 'terminal' && cursorRef) {
          cursorRef.lastEventId = serializeWaitCursor(currentCursor);
        }

        yield event;
      }
    } finally {
      await subscription.close();
    }
  } catch (error) {
    throwBackendCommunicationError(mapWaitSubscriptionError(error));
  }
}
