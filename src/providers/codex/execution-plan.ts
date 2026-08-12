import type { ProviderPreflightInput, ProviderPreflightRuntime, ProviderRequest } from '../contract.js';
import {
  allExecutionLifetimes,
  compileEnvironmentLayers,
  CORAL_PROCESS_ENV_KEYS,
  CORAL_TURN_ENV_KEYS,
  environmentLayer,
  EXECUTION_ENV_ALLOWLIST,
  filterEnvironmentValues,
  hostExecutionLifetime,
  type EnvironmentLayer,
  type ProviderExecutionPlan,
} from '../execution-plan.js';
import { shouldUseWindowsCommandShell, windowsCommandName } from '../../infra/windows-shell.js';
import { CODEX_ALLOWED_REQUEST_ENV_KEYS, CODEX_PROTECTED_REQUEST_ENV_KEYS } from './credential-policy.js';
import type { ProviderContinuityBlob } from '../../sessions/continuity.js';
import { resolveCodexHostCwd } from './request-mapping.js';
import type { CanonicalWorkDir } from '../../runtime/canonical-work-dir.js';

export type CodexProviderAccess = { readonly home: string };

export function codexRoutingEnv(access: CodexProviderAccess): Readonly<Record<string, string>> {
  return Object.freeze({ CODEX_HOME: access.home });
}

export type CodexExecutionPlan = ProviderExecutionPlan<
  Readonly<{
    platform: string;
    access: CodexProviderAccess;
    command: string;
    args: readonly string[];
    cwd: CanonicalWorkDir;
    environment: readonly EnvironmentLayer[];
    leaseMode: 'shared';
  }>,
  Readonly<{ sessionId: string }>,
  Readonly<{
    threadConfig: Readonly<Record<string, unknown>>;
  }>
>;

function baseLayer(values: Readonly<Record<string, string>>, platform: string): EnvironmentLayer {
  return environmentLayer(
    {
      name: 'daemon-base',
      lifetime: 'host',
      provenance: 'coral-daemon',
      values: filterEnvironmentValues(values, EXECUTION_ENV_ALLOWLIST, platform),
      writes: EXECUTION_ENV_ALLOWLIST,
      protects: new Set(),
    },
    platform,
  );
}

function childBoundaryLayer(platform: string): EnvironmentLayer {
  const values = { CORAL_CHILD: '1' } as const;
  return environmentLayer(
    {
      name: 'coral-child-boundary',
      lifetime: 'host',
      provenance: 'coral-daemon',
      values,
      writes: new Set(Object.keys(values)),
      protects: new Set(Object.keys(values)),
    },
    platform,
  );
}

function routingLayer(access: CodexProviderAccess, platform: string): EnvironmentLayer {
  const values = codexRoutingEnv(access);
  return environmentLayer(
    {
      name: 'codex-account-routing',
      lifetime: 'host',
      provenance: 'verified-provider-binding',
      values,
      writes: new Set(Object.keys(values)),
      protects: new Set([...Object.keys(values), ...CODEX_PROTECTED_REQUEST_ENV_KEYS]),
    },
    platform,
  );
}

function processSettingsLayer(values: Readonly<Record<string, string>>, platform: string): EnvironmentLayer {
  const allowed = new Set([...EXECUTION_ENV_ALLOWLIST, ...CORAL_PROCESS_ENV_KEYS]);
  return environmentLayer(
    {
      name: 'codex-process-settings',
      lifetime: 'host',
      provenance: 'provider-request-process',
      values: filterEnvironmentValues(values, allowed, platform),
      writes: allowed,
      protects: new Set(),
    },
    platform,
  );
}

function requestLayer(values: Readonly<Record<string, string>>, platform: string): EnvironmentLayer {
  const allowed = new Set([...CORAL_TURN_ENV_KEYS, ...CODEX_ALLOWED_REQUEST_ENV_KEYS]);
  return environmentLayer(
    {
      name: 'codex-turn-settings',
      lifetime: 'turn',
      provenance: 'provider-request',
      values: filterEnvironmentValues(values, allowed, platform),
      writes: allowed,
      protects: new Set(),
    },
    platform,
  );
}

function turnAuthorityLayer(
  request: ProviderRequest,
  protectedEnv: Readonly<Record<string, string>>,
  platform: string,
): EnvironmentLayer {
  const values = { CORAL_CHILD: '1', CORAL_SESSION_ID: request.sessionId, ...protectedEnv };
  return environmentLayer(
    {
      name: 'coral-turn-authority',
      lifetime: 'turn',
      provenance: 'coral-child-principal',
      values,
      writes: new Set(Object.keys(values)),
      protects: new Set(Object.keys(values)),
    },
    platform,
  );
}

export function compileCodexHostEnvironment(host: CodexExecutionPlan['host']): Readonly<Record<string, string>> {
  return compileEnvironmentLayers(host.environment, {
    platform: host.platform,
    lifetimes: hostExecutionLifetime(),
  });
}

/**
 * Build a Codex subprocess policy that preserves the compiled turn values while
 * pinning the non-secret Coral child marker last. Normal turns already carry the
 * marker from `turnAuthorityLayer`; interrupted recovery has no turn layers, so
 * this is where its resumed thread gets the marker.
 */
export function codexChildShellEnvironmentPolicy(
  values: Readonly<Record<string, string>> = {},
): Readonly<{ inherit: 'all'; set: Readonly<Record<string, string>> }> {
  return Object.freeze({
    inherit: 'all',
    set: Object.freeze({ ...values, CORAL_CHILD: '1' }),
  });
}

export function buildCodexHost(options: {
  access: CodexProviderAccess;
  request: ProviderRequest;
  persistedContinuity?: ProviderContinuityBlob;
  baseEnv: Readonly<Record<string, string>>;
  platform: string;
}): CodexExecutionPlan['host'] {
  return Object.freeze({
    platform: options.platform,
    access: options.access,
    command: 'codex',
    args: Object.freeze(['app-server']),
    cwd: resolveCodexHostCwd(options.request.cwd, options.persistedContinuity),
    environment: Object.freeze([
      baseLayer(options.baseEnv, options.platform),
      childBoundaryLayer(options.platform),
      routingLayer(options.access, options.platform),
      processSettingsLayer(options.request.coralEnv, options.platform),
    ]),
    leaseMode: 'shared' as const,
  });
}

export function buildCodexExecutionPlan(options: {
  access: CodexProviderAccess;
  hostPlan: CodexExecutionPlan['host'];
  request: ProviderRequest;
  persistedContinuity?: ProviderContinuityBlob;
  baseEnv: Readonly<Record<string, string>>;
  protectedEnv?: Readonly<Record<string, string>>;
  platform: string;
}): {
  readonly session: CodexExecutionPlan['session'];
  readonly turn: CodexExecutionPlan['turn'];
} {
  const threadConfigurationLayers = Object.freeze([
    turnAuthorityLayer(options.request, options.protectedEnv ?? {}, options.platform),
    requestLayer(options.request.coralEnv, options.platform),
  ]);
  const threadConfiguration = compileEnvironmentLayers(threadConfigurationLayers, {
    platform: options.platform,
    lifetimes: new Set(['turn']),
  });
  const plan: CodexExecutionPlan = Object.freeze({
    host: options.hostPlan,
    session: Object.freeze({ sessionId: options.request.sessionId }),
    turn: Object.freeze({
      threadConfig: Object.freeze({
        shell_environment_policy: codexChildShellEnvironmentPolicy(threadConfiguration),
      }),
    }),
  });
  return {
    session: plan.session,
    turn: plan.turn,
  };
}

export function buildCodexPreflightRuntime(
  input: ProviderPreflightInput<CodexProviderAccess>,
): ProviderPreflightRuntime<CodexProviderAccess> {
  const exactEnv = compileEnvironmentLayers(
    [
      baseLayer(input.baseEnv, input.platform),
      routingLayer(input.access, input.platform),
      processSettingsLayer(input.requestEnv, input.platform),
      requestLayer(input.requestEnv, input.platform),
    ],
    { platform: input.platform, lifetimes: allExecutionLifetimes() },
  );
  return {
    process: input.process,
    storage: input.storage,
    env: input.env,
    time: input.time,
    access: input.access,
    cwd: input.cwd,
    runExact: (command, args, options = {}) => {
      const compiledCommand = windowsCommandName(command, input.platform);
      return input.process.exec(compiledCommand, args, {
        ...options,
        cwd: input.cwd,
        env: { ...exactEnv },
        ...(input.platform === 'win32' ? { shell: shouldUseWindowsCommandShell(compiledCommand, input.platform) } : {}),
      });
    },
  };
}
