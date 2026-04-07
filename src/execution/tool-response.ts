import { isRecord } from '../shared/utils.js';
import type { LaunchDecision } from '../shared/types.js';

export type ToolDomainResult =
  | { ok: true; data: unknown }
  | { ok: false; code: string; message: string; detail?: unknown };

export function domainSuccess(data: unknown): ToolDomainResult {
  return { ok: true, data };
}

export function domainError(code: string, message: string, detail?: unknown): ToolDomainResult {
  return detail === undefined ? { ok: false, code, message } : { ok: false, code, message, detail };
}

export function deriveLegacyErrorMessage(code: string, detail?: unknown): string {
  if (typeof detail === 'string' && detail.length > 0) {
    return detail;
  }

  if (detail instanceof Error && detail.message.length > 0) {
    return detail.message;
  }

  if (isRecord(detail) && typeof detail.message === 'string' && detail.message.length > 0) {
    return detail.message;
  }

  return code.replaceAll('_', ' ');
}

export function launchDecisionToDomain(decision: LaunchDecision): ToolDomainResult {
  if (decision.status === 'rejected') {
    return domainError(decision.code, decision.message);
  }

  return domainSuccess(decision);
}

export function domainToHttp(result: ToolDomainResult): { statusCode: number; body: unknown } {
  return { statusCode: 200, body: result };
}

export function requireString(args: Record<string, unknown>, key: string): string | null {
  const value = args[key];
  return typeof value === 'string' ? value : null;
}

export function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' ? value : undefined;
}
