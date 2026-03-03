/**
 * Shared MCP utilities used by both ax (Codex/Claude) and dc (Discuss) servers.
 * Note: resultExtras is Codex-specific - dc server should NOT import it.
 */

/** MCP CallTool response shape. */
export type McpResult = { content: [{ type: 'text'; text: string }]; isError: boolean };

/** Identifier pattern: alphanumeric start, allows dots, hyphens, underscores. */
export const identPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

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

/**
 * Conditional error/warning/abort fields for Codex result responses.
 * Codex-specific - dc server should NOT import this.
 */
export function resultExtras(result: { exitCode: number | null; errors: string[]; warnings: string[]; aborted?: boolean }): Record<string, unknown> {
  const { exitCode, errors, warnings, aborted } = result;
  const extras: Record<string, unknown> = {};
  if (exitCode !== null && exitCode !== 0) extras.exit_code = exitCode;
  if (errors.length > 0) extras.errors = errors;
  if (warnings.length > 0) extras.warnings = warnings;
  if (aborted) extras.aborted = true;
  return extras;
}
