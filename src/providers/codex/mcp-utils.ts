/**
 * Conditional error/warning/abort fields for Codex result responses.
 * Codex-specific helper.
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
