export type ToolDomainResult =
  | { ok: true; data: unknown }
  | { ok: false; code: string; message: string; remediation?: string; detail?: unknown };

export function domainSuccess(data: unknown): ToolDomainResult {
  return { ok: true, data };
}

export function domainError(code: string, message: string, detail?: unknown): ToolDomainResult {
  return detail === undefined ? { ok: false, code, message } : { ok: false, code, message, detail };
}
