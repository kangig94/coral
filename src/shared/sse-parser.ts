import { isRecord, isStringArray } from './utils.js';
import type { WaitStreamEvent } from './types.js';

export const HEALTH_TIMEOUT_MS = 3_000;
export const TOOL_TIMEOUT_MS = 300_000;
export const MAX_WAIT_FETCH_TIMEOUT_MS = 30 * 60 * 1000;
export const WAIT_FETCH_MARGIN_MS = 30_000;

export type SseEventBlock = {
  event?: string;
  data: string;
  id?: string;
};

export function parseWaitStreamEvent(eventType: string | undefined, rawData: string): WaitStreamEvent | null {
  if (!eventType) return null;

  const parsed: unknown = JSON.parse(rawData);
  if (!isRecord(parsed) || parsed.type !== eventType) {
    throw new Error(`Invalid wait stream event payload for ${eventType}`);
  }

  switch (eventType) {
    case 'progress':
      if (
        typeof parsed.jobId === 'string' &&
        typeof parsed.sessionId === 'string' &&
        Number.isInteger(parsed.eventId) &&
        typeof parsed.message === 'string'
      ) {
        return parsed as WaitStreamEvent;
      }
      throw new Error('Invalid progress wait stream event');
    case 'terminal':
      if (
        typeof parsed.completedJobId === 'string' &&
        typeof parsed.sessionId === 'string' &&
        isStringArray(parsed.remainingJobIds) &&
        typeof parsed.resultPath === 'string' &&
        isRecord(parsed.result)
      ) {
        return parsed as WaitStreamEvent;
      }
      throw new Error('Invalid terminal wait stream event');
    case 'running':
      if (isStringArray(parsed.runningJobIds)) {
        return parsed as WaitStreamEvent;
      }
      throw new Error('Invalid running wait stream event');
    case 'queued':
      if (
        typeof parsed.jobId === 'string' &&
        typeof parsed.sessionId === 'string' &&
        typeof parsed.queuePosition === 'number' &&
        isStringArray(parsed.runningJobIds)
      ) {
        return parsed as WaitStreamEvent;
      }
      throw new Error('Invalid queued wait stream event');
    default:
      return null;
  }
}

export function parseSseBlock(block: string): SseEventBlock | null {
  if (!block.trim()) return null;

  let event: string | undefined;
  let id: string | undefined;
  const data: string[] = [];

  for (const rawLine of block.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (!line || line.startsWith(':')) continue;

    const separator = line.indexOf(':');
    const field = separator >= 0 ? line.slice(0, separator) : line;
    const value = separator >= 0 ? line.slice(separator + 1).replace(/^ /, '') : '';

    switch (field) {
      case 'event':
        event = value;
        break;
      case 'data':
        data.push(value);
        break;
      case 'id':
        id = value;
        break;
    }
  }

  if (data.length === 0) return null;
  return { event, data: data.join('\n'), id };
}

export function describeHttpError(status: number, statusText: string): string {
  if (status === 503) return 'Backend shutting down, retry';
  if (status === 401) return 'Backend auth failure - stale token';
  return `Backend request failed: ${status} ${statusText}`;
}

export async function parseJsonResponse(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}
