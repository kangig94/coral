import { dirname, join } from 'node:path';

import { detectClaudeCli } from '../cli-detection.js';
import type { ProviderPreflightRuntime, ProviderAppServerContract, ProviderRecoveryContract } from '../contract.js';
import {
  buildClaudeContinuity,
  buildClaudeProviderServerSpec,
  readClaudePersistedContinuity,
} from './request-mapping.js';
import { providerRoutingEnv, UNSUPPORTED_CLAUDE_SELECTOR_ENV_KEYS } from '../../infra/provider-credential-sources.js';

const UNSUPPORTED_CLAUDE_HELPER_SETTINGS = Object.freeze(
  new Set(['apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport']),
);

function claudeConfigRoot(runtime: ProviderPreflightRuntime): string {
  if (runtime.credentialSource.provider !== 'claude') throw new Error('Claude credential source required.');
  return runtime.credentialSource.configDir;
}

function assertSupportedClaudeSettings(runtime: ProviderPreflightRuntime): void {
  const settingsPaths = new Map<string, 'selected-profile' | 'project'>([
    [join(claudeConfigRoot(runtime), 'settings.json'), 'selected-profile'],
  ]);
  let directory = runtime.cwd;
  while (true) {
    const projectSettings = join(directory, '.claude', 'settings.json');
    const localProjectSettings = join(directory, '.claude', 'settings.local.json');
    if (!settingsPaths.has(projectSettings)) settingsPaths.set(projectSettings, 'project');
    if (!settingsPaths.has(localProjectSettings)) settingsPaths.set(localProjectSettings, 'project');
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }

  for (const [settingsPath, layer] of settingsPaths) {
    if (!runtime.storage.existsSync(settingsPath)) continue;

    let settings: unknown;
    try {
      settings = JSON.parse(runtime.storage.readFileSync(settingsPath, 'utf-8')) as unknown;
    } catch {
      throw new Error(
        `Cannot validate Claude credential selectors because the ${layer} settings contain invalid JSON. Repair or remove that settings file, then retry. See docs/configuration.md#multi-account-provider-routing.`,
      );
    }
    if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) {
      throw new Error(
        `Cannot validate Claude credential selectors because the ${layer} settings are not a JSON object. Repair or remove that settings file, then retry. See docs/configuration.md#multi-account-provider-routing.`,
      );
    }

    const record = settings as Record<string, unknown>;
    for (const helper of UNSUPPORTED_CLAUDE_HELPER_SETTINGS) {
      if (
        record[helper] !== undefined &&
        record[helper] !== null &&
        record[helper] !== false &&
        record[helper] !== ''
      ) {
        throw new Error(`Unsupported Claude credential helper '${helper}'. Remove it or run Claude outside Coral.`);
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
          `Unsupported Claude credential selector '${key}'. Remove it and select an account with an absolute CLAUDE_CONFIG_DIR, or run Claude outside Coral.`,
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
  finalizeInterrupted(probeResult, continuity, context) {
    const persistedContinuity = readClaudePersistedContinuity(probeResult.updatedContinuity ?? continuity ?? {});
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
} satisfies Pick<ProviderRecoveryContract, 'finalizeInterrupted'>;
