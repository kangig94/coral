// Hook-side mirror of src/infra/kb-toggle.ts. Hooks cannot import from src/,
// so the rule (KB disabled only on the explicit '0') is duplicated here and
// must stay in sync with resolveKbEnabled() / CORAL_KB_ENABLE_ENV.
export function isKbEnabled(env = process.env) {
  return env.CORAL_KB_ENABLE !== '0';
}
