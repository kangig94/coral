export const CODEX_CREDENTIAL_ENV_KEYS = Object.freeze([
  'CODEX_API_KEY',
  'CODEX_AUTH_TOKEN',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_ORGANIZATION',
  'OPENAI_PROJECT',
] as const);

export const CODEX_PROTECTED_REQUEST_ENV_KEYS = Object.freeze(['CODEX_HOME', ...CODEX_CREDENTIAL_ENV_KEYS] as const);

export const CODEX_ALLOWED_REQUEST_ENV_KEYS = Object.freeze(['CORAL_CODEX_EFFORT'] as const);

const CODEX_CREDENTIAL_ENV_KEY_LOOKUP: ReadonlySet<string> = new Set(CODEX_CREDENTIAL_ENV_KEYS);

export function isCodexCredentialEnvKey(key: string): boolean {
  return CODEX_CREDENTIAL_ENV_KEY_LOOKUP.has(key);
}
