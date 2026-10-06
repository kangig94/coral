import { createHash } from 'node:crypto';
import type { ProviderServerSpec } from './contract.js';

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalValue(entry)]),
    );
  }
  return value;
}

export function hostKeyFromSpec(spec: ProviderServerSpec): string {
  return JSON.stringify(
    canonicalValue({
      provider: spec.provider,
      command: spec.command,
      args: [...spec.args],
      cwd: spec.cwd,
      env: spec.env ?? {},
      initializeRequest: spec.initializeRequest ?? null,
      initializeTimeoutMs: spec.initializeTimeoutMs ?? null,
      shutdownCapability: spec.shutdownCapability ?? null,
    }),
  );
}

export function hostFingerprintFromSpec(spec: ProviderServerSpec): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        identity: hostKeyFromSpec(spec),
        leaseMode: spec.leaseMode,
        idleRetirement: spec.leaseMode === 'shared' ? spec.idleRetirement : null,
      }),
    )
    .digest('hex');
}
