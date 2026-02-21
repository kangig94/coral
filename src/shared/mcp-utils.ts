/**
 * Shared MCP utilities used by both cx (Codex) and dc (Discuss) servers.
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

/**
 * Conditional error/warning/abort fields for Codex result responses.
 * Codex-specific - dc server should NOT import this.
 */
export function resultExtras(result: { exitCode: number | null; errors: string[]; warnings: string[]; aborted?: boolean }): Record<string, unknown> {
  const extras: Record<string, unknown> = {};
  if (result.exitCode !== 0 && result.exitCode !== null) extras.exit_code = result.exitCode;
  if (result.errors.length > 0) extras.errors = result.errors;
  if (result.warnings.length > 0) extras.warnings = result.warnings;
  if (result.aborted) extras.aborted = true;
  return extras;
}
