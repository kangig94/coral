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

function executableIdentity(spec: ProviderServerSpec): Record<string, unknown> {
  return {
    provider: spec.provider,
    command: spec.command,
    args: [...spec.args],
    env: spec.env ?? {},
    initializeRequest: spec.initializeRequest ?? null,
    initializeTimeoutMs: spec.initializeTimeoutMs ?? null,
    shutdownCapability: spec.shutdownCapability ?? null,
  };
}

function fingerprintOf(identity: string, spec: ProviderServerSpec): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        identity,
        leaseMode: spec.leaseMode,
        idleRetirement: spec.leaseMode === 'shared' ? spec.idleRetirement : null,
      }),
    )
    .digest('hex');
}

export function hostKeyFromSpec(spec: ProviderServerSpec): string {
  return JSON.stringify(canonicalValue({ ...executableIdentity(spec), cwd: spec.cwd }));
}

export function hostFingerprintFromSpec(spec: ProviderServerSpec): string {
  return fingerprintOf(hostKeyFromSpec(spec), spec);
}

export function proxySetKeyFromSpec(spec: ProviderServerSpec): string {
  return JSON.stringify(canonicalValue(executableIdentity(spec)));
}

export function proxySetFingerprintFromSpec(spec: ProviderServerSpec): string {
  return fingerprintOf(proxySetKeyFromSpec(spec), spec);
}
