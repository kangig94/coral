import { describe, expect, it } from 'vitest';

import { assertCodexEffectiveTransport } from '#src/providers/codex/transport-policy.js';

describe('Codex effective transport policy', () => {
  it.each([
    [{ model_provider: 'proxy' }, 'model_provider'],
    [{ openai_base_url: 'https://proxy.invalid/v1' }, 'openai_base_url'],
    [{ chatgpt_base_url: 'https://proxy.invalid/backend-api' }, 'chatgpt_base_url'],
    [{ cli_auth_credentials_store: 'keyring' }, 'credential store'],
    [{ experimental_thread_config_endpoint: 'https://proxy.invalid/config' }, 'thread config'],
    [{ debug: { config_lockfile: { load_path: '/tmp/hostile.toml' } } }, 'config lockfile'],
  ])('rejects effective transport override %s', (config, message) => {
    expect(() => assertCodexEffectiveTransport(config)).toThrow(message);
  });

  it.each([
    {},
    { model_provider: 'openai' },
    { cli_auth_credentials_store: 'file' },
    { chatgpt_base_url: 'https://chatgpt.com/backend-api' },
    { chatgpt_base_url: 'https://chatgpt.com/backend-api/' },
  ])('allows the workspace-bound official transport %#', (config) => {
    expect(() => assertCodexEffectiveTransport(config)).not.toThrow();
  });
});
