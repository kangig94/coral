/**
 * Environment variable that gates the KB daemon runtime. The documented values are
 * `'1'` (enabled) and `'0'` (disabled); unset means enabled. Any other value
 * fails open to enabled (the caller is expected to warn once).
 */
export const CORAL_KB_ENABLE_ENV = 'CORAL_KB_ENABLE';

/**
 * Resolve whether KB is enabled from the raw `CORAL_KB_ENABLE` value. KB is
 * disabled only on the explicit string `'0'`; unset or any other value leaves
 * it enabled, so a malformed value never silently turns the component off.
 */
export function resolveKbEnabled(value: string | undefined): boolean {
  return value !== '0';
}

/**
 * `offline` reason reported by the disabled KB daemon health component. Shared so the CLI can
 * tell an intentionally-disabled KB apart from one that failed to boot, and
 * decide whether to restart the daemon to re-enable it.
 */
export const KB_DISABLED_REASON = 'disabled (CORAL_KB_ENABLE=0)';
