import { dirname, join } from 'node:path';

import { detectClaudeCli } from '../cli-detection.js';
import type {
  ProviderPreflightRuntime,
  ProviderAppServerContract,
  ProviderRecoveryContract,
  ProviderRequest,
} from '../contract.js';
import { readString } from '../../infra/json.js';
import {
  buildClaudeContinuity,
  buildClaudeProviderServerSpec,
  claudeConversationRef,
  readClaudePersistedContinuity,
} from './request-mapping.js';
import { providerRoutingEnv, UNSUPPORTED_CLAUDE_SELECTOR_ENV_KEYS } from '../../infra/provider-credential-sources.js';

const UNSUPPORTED_CLAUDE_HELPER_SETTINGS = Object.freeze(
  new Set(['apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport']),
);

function claudeConfigRoot(runtime: ProviderPreflightRuntime): string {
  if (runtime.credentialSource.provider !== 'claude') throw new Error('Claude credential source required.');
  return runtime.credentialSource.kind === 'config-dir'
    ? runtime.credentialSource.configDir
    : runtime.credentialSource.configDirLocator;
}

function assertSupportedClaudeSettings(runtime: ProviderPreflightRuntime): void {
  const settingsPaths = new Set([join(claudeConfigRoot(runtime), 'settings.json')]);
  let directory = runtime.cwd;
  while (true) {
    settingsPaths.add(join(directory, '.claude', 'settings.json'));
    settingsPaths.add(join(directory, '.claude', 'settings.local.json'));
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }

  for (const settingsPath of settingsPaths) {
    if (!runtime.storage.existsSync(settingsPath)) continue;

    let settings: unknown;
    try {
      settings = JSON.parse(runtime.storage.readFileSync(settingsPath, 'utf-8')) as unknown;
    } catch {
      throw new Error(`Cannot validate Claude credential selectors in '${settingsPath}'. Fix the JSON and retry.`);
    }
    if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) {
      throw new Error(`Cannot validate Claude credential selectors in '${settingsPath}': expected a JSON object.`);
    }

    const record = settings as Record<string, unknown>;
    for (const helper of UNSUPPORTED_CLAUDE_HELPER_SETTINGS) {
      if (
        record[helper] !== undefined &&
        record[helper] !== null &&
        record[helper] !== false &&
        record[helper] !== ''
      ) {
        throw new Error(
          `Unsupported Claude credential helper '${helper}' in '${settingsPath}'. Remove it or run Claude outside Coral.`,
        );
      }
    }

    const configuredEnv = record.env;
    if (configuredEnv === null || typeof configuredEnv !== 'object' || Array.isArray(configuredEnv)) continue;
    for (const [key, value] of Object.entries(configuredEnv as Record<string, unknown>)) {
      const selectorKey = key.toUpperCase();
      if (
        UNSUPPORTED_CLAUDE_SELECTOR_ENV_KEYS.has(selectorKey) &&
        ((typeof value === 'string' && value.trim().length > 0) ||
          (typeof value !== 'string' && value !== null && value !== undefined))
      ) {
        throw new Error(
          `Unsupported Claude credential selector '${key}' in '${settingsPath}'. Remove it and select an account with an absolute CLAUDE_CONFIG_DIR, or run Claude outside Coral.`,
        );
      }
    }
  }
}

export async function claudePreflight(runtime: ProviderPreflightRuntime): Promise<void> {
  if (runtime.credentialSource.provider !== 'claude') throw new Error('Claude credential source required.');
  assertSupportedClaudeSettings(runtime);
  const routingEnv = providerRoutingEnv(runtime.credentialSource);
  const cli = await detectClaudeCli(
    { exec: (command, args, options) => runtime.runExact(command, args, options) },
    { get: (key) => routingEnv[key] },
  );
  if (!cli.available) {
    throw new Error(`Claude CLI not available: ${cli.error}`);
  }
  if (cli.authState === 'unauthenticated') {
    throw new Error(`Claude CLI unauthenticated: ${cli.authError}`);
  }
}

export const claudeAppServerLifecycle: ProviderAppServerContract = {
  name: 'claude',
  subscriptionPhase: 'beforeInitialize',
  buildServerSpec(request, _persistedContinuity, ports, providerContext) {
    if (providerContext.provider !== 'claude') throw new Error('Claude provider context required.');
    return buildClaudeProviderServerSpec(request, ports.storage, providerContext.brokerEnv);
  },
};

export const claudeRecoveryLifecycle = {
  buildRecoveryMeta(request: ProviderRequest) {
    const conversationRef = readString(claudeConversationRef(request));
    return conversationRef !== undefined ? { conversationRef } : {};
  },
  finalizeInterrupted(probeResult, continuity, context) {
    const persistedContinuity = readClaudePersistedContinuity(probeResult.updatedContinuity ?? continuity);
    const providerContinuity = persistedContinuity.bootstrapSignature
      ? buildClaudeContinuity({
          bootstrapSignature: persistedContinuity.bootstrapSignature,
        })
      : undefined;
    const effectiveConversationRef = context.preservedConversationRef;

    if (probeResult.resumable) {
      if (effectiveConversationRef !== undefined) {
        return {
          kind: 'set_resumable',
          conversationRef: effectiveConversationRef,
          ...(providerContinuity ? { providerContinuity } : {}),
        };
      }

      return {
        kind: 'preserve',
        ...(providerContinuity ? { providerContinuity } : {}),
      };
    }

    return {
      kind: 'clear_non_resumable',
      ...(providerContinuity ? { providerContinuity } : {}),
    };
  },
} satisfies Pick<ProviderRecoveryContract, 'buildRecoveryMeta' | 'finalizeInterrupted'>;
