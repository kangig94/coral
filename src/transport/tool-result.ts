import { isRecord } from '../infra/json.js';

export type ToolDomainResult =
  | { ok: true; data: unknown }
  | { ok: false; code: string; message: string; detail?: unknown };

export function domainSuccess(data: unknown): ToolDomainResult {
  return { ok: true, data };
}

export function domainError(code: string, message: string, detail?: unknown): ToolDomainResult {
  return detail === undefined ? { ok: false, code, message } : { ok: false, code, message, detail };
}

export function toolValidationError(error: { message: string }): ToolDomainResult {
  return domainError('invalid_request', error.message);
}

export function deriveErrorMessage(code: string, detail?: unknown): string {
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
