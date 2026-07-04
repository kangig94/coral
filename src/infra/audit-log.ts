import { backendLog } from './backend-log.js';
import type { Capability } from '../security/capability.js';
import type { Principal, ResourceBinding } from '../security/principal.js';
import type { AuthorizationFailureDetail, AuthorizationFailureReason, Decision } from '../security/policy/authorize.js';

export type AuditLogLevel = 'info' | 'warn' | 'error';
export type AuditPayload = Record<string, unknown>;

type PrincipalAuditDescriptor = {
  readonly subject: Principal['subject'];
  readonly transport: string;
  readonly binding: ResourceBinding;
  readonly attenuatedCaps: readonly Capability[] | null;
};

type DecisionAuditDescriptor =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: AuthorizationFailureReason;
      readonly detail: AuthorizationFailureDetail;
    };

const REDACTED = '[redacted]';
const MAX_DEPTH = 6;
const MAX_ARRAY_ITEMS = 50;
const MAX_STRING_CHARS = 4096;

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return (
    normalized.includes('token') ||
    normalized.includes('secret') ||
    normalized.includes('password') ||
    normalized.includes('credential') ||
    normalized === 'authorization' ||
    normalized === 'apikey' ||
    normalized === 'api_key'
  );
}

function truncateString(value: string): string {
  if (value.length <= MAX_STRING_CHARS) return value;
  return `${value.slice(0, MAX_STRING_CHARS)}...[truncated]`;
}

function sanitizeAuditValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null) return null;
  if (typeof value === 'string') return truncateString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol') {
    return undefined;
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
    };
  }
  if (depth >= MAX_DEPTH) {
    return '[max-depth]';
  }
  if (typeof value !== 'object') {
    return '[unsupported]';
  }
  if (seen.has(value)) {
    return '[circular]';
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const entries = value.slice(0, MAX_ARRAY_ITEMS).map((entry) => sanitizeAuditValue(entry, depth + 1, seen));
      if (value.length > MAX_ARRAY_ITEMS) {
        entries.push(`[${value.length - MAX_ARRAY_ITEMS} more items]`);
      }
      return entries;
    }

    const sanitized: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (isSensitiveKey(key)) {
        sanitized[key] = REDACTED;
        continue;
      }
      const sanitizedEntry = sanitizeAuditValue(entry, depth + 1, seen);
      if (sanitizedEntry !== undefined) {
        sanitized[key] = sanitizedEntry;
      }
    }
    return sanitized;
  } finally {
    seen.delete(value);
  }
}

function sanitizePayload(payload: AuditPayload): AuditPayload {
  const sanitized = sanitizeAuditValue(payload, 0, new WeakSet<object>());
  return sanitized && typeof sanitized === 'object' && !Array.isArray(sanitized) ? (sanitized as AuditPayload) : {};
}

function describePrincipal(principal: Principal | null | undefined): PrincipalAuditDescriptor | null {
  if (!principal) {
    return null;
  }

  return {
    subject: principal.subject,
    transport: principal.transport,
    binding: principal.binding,
    attenuatedCaps: principal.attenuatedCaps ? [...principal.attenuatedCaps].sort() : null,
  };
}

function describeDecision(decision: Decision): DecisionAuditDescriptor {
  if (decision.ok) {
    return { ok: true };
  }

  return {
    ok: false,
    reason: decision.reason,
    detail: decision.detail,
  };
}

export function describeAuthorizationDecision(
  principal: Principal | null | undefined,
  method: string,
  decision: Decision,
  binding: ResourceBinding,
): AuditPayload {
  return {
    principal: describePrincipal(principal),
    method,
    decision: describeDecision(decision),
    binding,
  };
}

export function writeAuthorizationDecisionAudit(
  principal: Principal | null | undefined,
  method: string,
  decision: Decision,
  binding: ResourceBinding,
  level: AuditLogLevel = decision.ok ? 'info' : 'warn',
): void {
  writeAuditEvent('authorization_decision', describeAuthorizationDecision(principal, method, decision, binding), level);
}

export function formatAuditEvent(event: string, payload: AuditPayload = {}): string {
  const record = {
    ...sanitizePayload(payload),
    schemaVersion: 1,
    event,
    recordedAt: new Date().toISOString(),
  };
  return `audit ${JSON.stringify(record)}`;
}

export function writeAuditEvent(event: string, payload: AuditPayload = {}, level: AuditLogLevel = 'info'): void {
  const message = formatAuditEvent(event, payload);
  if (level === 'error') {
    backendLog.error(message);
    return;
  }
  if (level === 'warn') {
    backendLog.warn(message);
    return;
  }
  backendLog.info(message);
}
