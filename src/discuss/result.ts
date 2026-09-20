import { isRecord } from '../infra/json.js';

export type DiscussToolResult =
  | { ok: true; data: unknown }
  | { ok: false; code: string; message: string; detail?: unknown };

export function discussToolSuccess(data: unknown): DiscussToolResult {
  return { ok: true, data };
}

export function discussToolError(code: string, message: string, detail?: unknown): DiscussToolResult {
  return detail === undefined ? { ok: false, code, message } : { ok: false, code, message, detail };
}

export function deriveDiscussErrorMessage(code: string, detail?: unknown): string {
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
