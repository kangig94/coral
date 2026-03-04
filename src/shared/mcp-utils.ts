export type McpResult = { content: [{ type: 'text'; text: string }]; isError: boolean };

export function isNoEntryError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export const identPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

export const providerIdentPattern = /^[a-z][a-z0-9-]*$/;

export function textResult(text: string, isError = false): McpResult {
  return { content: [{ type: 'text' as const, text }], isError };
}

export function jsonResult(data: Record<string, unknown>): McpResult {
  return textResult(JSON.stringify(data, null, 2));
}

type ResultLike<T extends Record<string, unknown>> =
  | { ok: true; value: T }
  | { ok: false; error: string; detail?: Record<string, unknown> };

export function resultToMcp<T extends Record<string, unknown>>(result: ResultLike<T>): McpResult {
  if (result.ok) return jsonResult(result.value);
  return jsonResult({ error: result.error, ...(result.detail ?? {}) });
}
