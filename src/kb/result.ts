import { isRecord } from '../infra/json.js';

export type KbToolResult = { ok: true; data: unknown } | { ok: false; code: string; message: string; detail?: unknown };

export function kbSuccess(data: unknown): KbToolResult {
  return { ok: true, data };
}

export function kbError(code: string, message: string, detail?: unknown): KbToolResult {
  return detail === undefined ? { ok: false, code, message } : { ok: false, code, message, detail };
}

export function kbValidationError(error: { message: string }): KbToolResult {
  return kbError('invalid_request', error.message);
}

export function deriveKbErrorMessage(code: string, detail?: unknown): string {
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
