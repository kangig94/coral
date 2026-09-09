import { dirname, join } from 'node:path';

import { detectClaudeCli } from './cli-detection.js';
import type {
  AppServerTransport,
  ProviderInterruptRequestOutcome,
  ProviderPreflightOutcome,
  ProviderPreflightRuntime,
  ProviderAppServerCapability,
  ProviderRecoveryContract,
} from '../contract.js';
import type { ProviderContinuityBlob } from '../../sessions/continuity.js';
import { isRecord, readString } from '../../infra/json.js';
import { mapInterruptParams } from './request-mapping.js';
import {
  buildClaudeContinuity,
  buildClaudeProviderServerSpec,
  readClaudePersistedContinuity,
} from './request-mapping.js';
import {
  buildClaudeHost,
  claudeRoutingEnv,
  compileClaudeBrokerHost,
  type ClaudeProviderAccess,
  type ClaudeExecutionPlan,
} from './execution-plan.js';
import { isClaudeCredentialEnvKey } from './credential-policy.js';
import { resolveClaudeTransportMode } from './transport-mode.js';

const UNSUPPORTED_CLAUDE_HELPER_SETTINGS: ReadonlySet<string> = new Set([
  'apiKeyHelper',
  'awsAuthRefresh',
  'awsCredentialExport',
]);

function claudeConfigRoot(runtime: ProviderPreflightRuntime<ClaudeProviderAccess>): string {
  return runtime.access.configDir;
}

function checkSupportedClaudeSettings(
  runtime: ProviderPreflightRuntime<ClaudeProviderAccess>,
): ProviderPreflightOutcome {
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

  let readFailure: Extract<ProviderPreflightOutcome, { kind: 'undetermined' }> | undefined;
  for (const [settingsPath, layer] of settingsPaths) {
    if (!runtime.storage.existsSync(settingsPath)) continue;

    let raw: string;
    try {
      raw = runtime.storage.readFileSync(settingsPath, 'utf-8');
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException).code;
      const remedy =
        code === 'EACCES' || code === 'EPERM'
          ? ' Check that these settings are readable by the user running the Coral daemon, then retry.'
          : ' Retry the command.';
      readFailure ??= {
        kind: 'undetermined',
        message: `Cannot validate Claude credential selectors because the ${layer} settings could not be read (${code ?? 'unknown error'}); their contents were not observed.${remedy}`,
      };
      continue;
    }

    let settings: unknown;
    try {
      settings = JSON.parse(raw) as unknown;
    } catch {
      return {
        kind: 'refused',
        message: `Cannot validate Claude credential selectors because the ${layer} settings contain invalid JSON. Repair or remove that settings file, then retry. See docs/configuration.md#multi-account-provider-routing.`,
      };
    }
    if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) {
      return {
        kind: 'refused',
        message: `Cannot validate Claude credential selectors because the ${layer} settings are not a JSON object. Repair or remove that settings file, then retry. See docs/configuration.md#multi-account-provider-routing.`,
      };
    }

    const record = settings as Record<string, unknown>;
    for (const helper of UNSUPPORTED_CLAUDE_HELPER_SETTINGS) {
      if (
        record[helper] !== undefined &&
        record[helper] !== null &&
        record[helper] !== false &&
        record[helper] !== ''
      ) {
        return {
          kind: 'refused',
          message: `Unsupported Claude credential helper '${helper}'. Remove it or run Claude outside Coral.`,
        };
      }
    }

    const configuredEnv = record.env;
    if (configuredEnv === null || typeof configuredEnv !== 'object' || Array.isArray(configuredEnv)) continue;
    for (const [key, value] of Object.entries(configuredEnv as Record<string, unknown>)) {
      const selectorKey = key.toUpperCase();
      if (
        isClaudeCredentialEnvKey(selectorKey) &&
        ((typeof value === 'string' && value.trim().length > 0) ||
          (typeof value !== 'string' && value !== null && value !== undefined))
      ) {
        return {
          kind: 'refused',
          message: `Unsupported Claude credential selector '${key}'. Remove it and select an account with an absolute CLAUDE_CONFIG_DIR, or run Claude outside Coral.`,
        };
      }
    }
  }

  return readFailure ?? { kind: 'satisfied' };
}

export async function claudePreflight(
  runtime: ProviderPreflightRuntime<ClaudeProviderAccess>,
): Promise<ProviderPreflightOutcome> {
  const settingsOutcome = checkSupportedClaudeSettings(runtime);
  if (settingsOutcome.kind !== 'satisfied') return settingsOutcome;
  const routingEnv = claudeRoutingEnv(runtime.access);
  const cli = await detectClaudeCli(
    { exec: (command, args, options) => runtime.runExact(command, args, options) },
    { get: (key) => routingEnv[key] },
  );
  if (!cli.available) {
    return cli.reason === 'undetermined'
      ? { kind: 'undetermined', message: `Claude CLI availability is unknown — ${cli.error}` }
      : { kind: 'refused', message: `Claude CLI not available: ${cli.error}` };
  }
  if (cli.authState === 'unauthenticated') {
    return { kind: 'refused', message: cli.authError };
  }
  // Unknown authentication may proceed because execution can report unauthenticated cheaply and decisively.
  // Unknown availability may not: committing a job before another EAGAIN would leave it with the same non-answer.
  return { kind: 'satisfied' };
}

export const claudeAppServerLifecycle: ProviderAppServerCapability<ClaudeExecutionPlan, ClaudeProviderAccess> = {
  name: 'claude',
  planHost: (input) =>
    buildClaudeHost({
      access: input.access,
      request:
        input.purpose === 'execution'
          ? input.request
          : { cwd: input.request.cwd, coralEnv: { CORAL_CLAUDE_TRANSPORT: 'print' } },
      baseEnv: input.baseEnv,
      platform: input.platform,
      storage: input.storage,
      transportMode: input.purpose === 'curation' ? 'print' : resolveClaudeTransportMode(input.request.coralEnv),
    }),
  compileStableHost: (host) =>
    buildClaudeProviderServerSpec(compileClaudeBrokerHost({ platform: host.platform, broker: host.broker })),
  async interrupt(
    transport: AppServerTransport,
    continuity: ProviderContinuityBlob,
  ): Promise<ProviderInterruptRequestOutcome> {
    const persistedContinuity = readClaudePersistedContinuity(continuity);
    const brokerSessionKey = persistedContinuity.brokerSessionKey;
    if (brokerSessionKey === undefined) {
      return { kind: 'not-accepted', reason: 'Claude continuity is missing the broker session key.' };
    }
    const brokerTurnId = persistedContinuity.brokerTurnId;
    if (brokerTurnId === undefined) {
      return { kind: 'not-accepted', reason: 'Claude continuity is missing the broker turn id.' };
    }
    const result = await transport.rpc<unknown>(
      'turn/interrupt',
      mapInterruptParams(brokerSessionKey, brokerTurnId) as unknown as Record<string, unknown>,
    );
    return isRecord(result) && result.interrupted === true && readString(result.brokerTurnId) === brokerTurnId
      ? { kind: 'accepted' }
      : { kind: 'not-accepted', reason: 'Claude did not acknowledge the exact active broker turn.' };
  },
};

export const claudeRecoveryLifecycle = {
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
} satisfies Pick<ProviderRecoveryContract, 'finalizeInterrupted'>;
