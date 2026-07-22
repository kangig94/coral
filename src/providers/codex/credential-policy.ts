export const CODEX_CREDENTIAL_ENV_KEYS = Object.freeze(
  new Set([
    'CODEX_API_KEY',
    'CODEX_AUTH_TOKEN',
    'OPENAI_API_KEY',
    'OPENAI_BASE_URL',
    'OPENAI_ORGANIZATION',
    'OPENAI_PROJECT',
  ]),
);

export const CODEX_PROTECTED_REQUEST_ENV_KEYS = Object.freeze(new Set(['CODEX_HOME', ...CODEX_CREDENTIAL_ENV_KEYS]));

export const CODEX_ALLOWED_REQUEST_ENV_KEYS = Object.freeze(new Set(['CORAL_CODEX_EFFORT']));
