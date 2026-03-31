import { isRecord } from '../shared/mcp-utils.js';

/**
 * Health metadata exposed by the Coral backend.
 */
export interface BackendHealth {
  status: 'ok';
  version: string;
  bundleHash: string;
  instanceId: string;
  namespace: string;
  uptimeMs: number;
  activeChildren: number;
  activeJobs: number;
  inflightRequests: number;
  queueDepth: number;
}

export function isBackendHealth(value: unknown): value is BackendHealth {
  return (
    isRecord(value) &&
    value.status === 'ok' &&
    typeof value.version === 'string' &&
    typeof value.bundleHash === 'string' &&
    typeof value.instanceId === 'string' &&
    typeof value.namespace === 'string' &&
    value.namespace.length > 0 &&
    Number.isFinite(value.uptimeMs) &&
    Number.isInteger(value.activeChildren) &&
    Number.isInteger(value.activeJobs) &&
    Number.isInteger(value.inflightRequests) &&
    Number.isInteger(value.queueDepth)
  );
}
