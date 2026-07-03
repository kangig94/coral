import { nowIsoString } from '../infra/time.js';
import type { JobProgressTiming } from './event-bodies.js';

type ProgressTimingProjection = {
  status: { phase: string; updatedAt: string } | null;
  runtime: { startTime: string } | null;
  launch: { createdAt: string } | null;
};

function parseIsoEpochMs(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function fallbackTiming(origin: JobProgressTiming['origin'], nowMs: number): JobProgressTiming {
  const emittedAt = nowIsoString(nowMs);
  return {
    origin,
    originAt: emittedAt,
    emittedAt,
    elapsedMs: 0,
  };
}

function parsedTiming(
  origin: JobProgressTiming['origin'],
  originAt: string | undefined,
  nowMs: number,
): JobProgressTiming | null {
  const originAtMs = parseIsoEpochMs(originAt);
  if (originAtMs === null) {
    return null;
  }
  const emittedAt = nowIsoString(nowMs);
  return {
    origin,
    originAt: originAt ?? emittedAt,
    emittedAt,
    elapsedMs: Math.max(0, nowMs - originAtMs),
  };
}

export function queuedProgressTiming(status: { updatedAt: string }, nowMs: number): JobProgressTiming {
  return parsedTiming('queued', status.updatedAt, nowMs) ?? fallbackTiming('queued', nowMs);
}

export function progressTimingFromProjection(detail: ProgressTimingProjection, nowMs: number): JobProgressTiming {
  const runtimeTiming = parsedTiming('runtime', detail.runtime?.startTime, nowMs);
  if (runtimeTiming !== null) {
    return runtimeTiming;
  }

  const queuedTiming =
    detail.status?.phase === 'queued' ? parsedTiming('queued', detail.status.updatedAt, nowMs) : null;
  if (queuedTiming !== null) {
    return queuedTiming;
  }

  return parsedTiming('launch', detail.launch?.createdAt, nowMs) ?? fallbackTiming('launch', nowMs);
}
