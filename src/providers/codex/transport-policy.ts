import type { ProviderServerLease } from '../contract.js';
import type { AppServerResponse } from './protocol.js';

const OFFICIAL_CHATGPT_BASE_URLS = new Set(['https://chatgpt.com/backend-api', 'https://chatgpt.com/backend-api/']);

function nonBlank(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function nestedRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function unsupportedCodexTransportSetting(config: Record<string, unknown>): string | undefined {
  const modelProvider = nonBlank(config.model_provider);
  if (modelProvider !== undefined && modelProvider !== 'openai') {
    return 'model_provider';
  }
  if (nonBlank(config.openai_base_url) !== undefined) {
    return 'openai_base_url';
  }
  const chatgptBaseUrl = nonBlank(config.chatgpt_base_url);
  if (chatgptBaseUrl !== undefined && !OFFICIAL_CHATGPT_BASE_URLS.has(chatgptBaseUrl)) {
    return 'chatgpt_base_url';
  }
  const credentialStore = nonBlank(config.cli_auth_credentials_store);
  if (credentialStore !== undefined && credentialStore !== 'file') {
    return 'cli_auth_credentials_store';
  }
  if (nonBlank(config.experimental_thread_config_endpoint) !== undefined) {
    return 'experimental_thread_config_endpoint';
  }
  const debug = nestedRecord(config.debug);
  const lockfile = nestedRecord(debug?.config_lockfile);
  if (nonBlank(lockfile?.load_path) !== undefined) {
    return 'debug.config_lockfile.load_path';
  }
  if (nonBlank(config.profile) !== undefined) return 'profile';
  return undefined;
}

function transportRecovery(setting: string): string {
  switch (setting) {
    case 'model_provider':
      return "Set model_provider to 'openai' or remove it, then retry with the same CODEX_HOME.";
    case 'cli_auth_credentials_store':
      return "Set cli_auth_credentials_store to 'file' or remove it, then retry with the same CODEX_HOME.";
    case 'chatgpt_base_url':
      return 'Remove chatgpt_base_url or restore the official ChatGPT endpoint, then retry with the same CODEX_HOME.';
    case 'profile':
      return 'Remove the root profile selector and apply supported settings directly, then retry with the same CODEX_HOME.';
    default:
      return `Remove ${setting} from the effective Codex configuration, then retry with the same CODEX_HOME.`;
  }
}

function transportSettingLabel(setting: string): string {
  switch (setting) {
    case 'cli_auth_credentials_store':
      return `credential store setting '${setting}'`;
    case 'experimental_thread_config_endpoint':
      return `thread config endpoint '${setting}'`;
    case 'debug.config_lockfile.load_path':
      return `config lockfile setting '${setting}'`;
    default:
      return `effective setting '${setting}'`;
  }
}

export function assertCodexEffectiveTransport(config: Record<string, unknown>): void {
  const setting = unsupportedCodexTransportSetting(config);
  if (setting !== undefined) {
    throw new Error(`Unsupported Codex ${transportSettingLabel(setting)}. ${transportRecovery(setting)}`);
  }
}

export async function verifyCodexEffectiveTransport(lease: ProviderServerLease, cwd: string): Promise<void> {
  const response = await lease.rpc<AppServerResponse<'config/read'>>('config/read', {
    includeLayers: false,
    cwd,
  });
  assertCodexEffectiveTransport(response.config);
}
