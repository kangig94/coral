import { isRecord } from '../../../infra/json.js';

/**
 * Health metadata exposed by the Coral backend over HTTP.
 *
 * `subsystems.kb` is a typed object with sub-fields for `mutationBlocked` and
 * `consumerStuck` carrying full diagnostic context. The flat sibling
 * `kbReason` was removed; callers now read `subsystems.kb.reason`.
 */
export interface BackendHealth {
  status: 'ok';
  version: string;
  bundleHash: string;
  flavor: 'prod' | 'dev';
  instanceId: string;
  namespace: string;
  uptimeMs: number;
  active: number;
  activeJobs: number;
  inflightRequests: number;
  queueDepth: number;
  subsystems: {
    kb: {
      kind: 'ok' | 'initializing' | 'unavailable';
      reason?: string;
      mutationBlocked?: { owner: string; ageMs: number; signaledAtMs: number };
      consumerStuck?: Array<{ id: string; elapsedSinceStopMs: number }>;
    };
    kbCurate: 'ok' | 'degraded';
    kbCurateReason?: string;
    discuss: 'ok';
  };
}

function isMutationBlocked(value: unknown): value is { owner: string; ageMs: number; signaledAtMs: number } {
  return (
    isRecord(value) &&
    typeof value.owner === 'string' &&
    Number.isFinite(value.ageMs) &&
    Number.isFinite(value.signaledAtMs)
  );
}

function isConsumerStuck(value: unknown): value is Array<{ id: string; elapsedSinceStopMs: number }> {
  if (!Array.isArray(value)) {
    return false;
  }
  return value.every(
    (entry) => isRecord(entry) && typeof entry.id === 'string' && Number.isFinite(entry.elapsedSinceStopMs),
  );
}

function isKbHealth(value: unknown): value is BackendHealth['subsystems']['kb'] {
  if (!isRecord(value)) {
    return false;
  }
  if (value.kind !== 'ok' && value.kind !== 'initializing' && value.kind !== 'unavailable') {
    return false;
  }
  if (value.reason !== undefined && typeof value.reason !== 'string') {
    return false;
  }
  if (value.mutationBlocked !== undefined && !isMutationBlocked(value.mutationBlocked)) {
    return false;
  }
  if (value.consumerStuck !== undefined && !isConsumerStuck(value.consumerStuck)) {
    return false;
  }
  return true;
}

function isSubsystems(value: unknown): value is BackendHealth['subsystems'] {
  if (!isRecord(value)) {
    return false;
  }
  if (!isKbHealth(value.kb)) {
    return false;
  }
  if (value.kbCurate !== 'ok' && value.kbCurate !== 'degraded') {
    return false;
  }
  if (value.kbCurateReason !== undefined && typeof value.kbCurateReason !== 'string') {
    return false;
  }
  if (value.discuss !== 'ok') {
    return false;
  }
  return true;
}

export function isBackendHealth(value: unknown): value is BackendHealth {
  return (
    isRecord(value) &&
    value.status === 'ok' &&
    typeof value.version === 'string' &&
    typeof value.bundleHash === 'string' &&
    (value.flavor === 'prod' || value.flavor === 'dev') &&
    typeof value.instanceId === 'string' &&
    typeof value.namespace === 'string' &&
    value.namespace.length > 0 &&
    Number.isFinite(value.uptimeMs) &&
    Number.isInteger(value.active) &&
    Number.isInteger(value.activeJobs) &&
    Number.isInteger(value.inflightRequests) &&
    Number.isInteger(value.queueDepth) &&
    isSubsystems(value.subsystems)
  );
}
