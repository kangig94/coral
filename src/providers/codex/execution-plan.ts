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
import type { ProviderCliRequest } from '../protocol.js';
import { CODEX_ALLOWED_REQUEST_ENV_KEYS, CODEX_PROTECTED_REQUEST_ENV_KEYS } from './credential-policy.js';
import type { ProviderContinuityBlob } from '../../sessions/continuity.js';
import { resolveCodexHostCwd } from './request-mapping.js';

export type CodexCredentialSource = { readonly home: string };

export function codexRoutingEnv(source: CodexCredentialSource): Readonly<Record<string, string>> {
  return Object.freeze({ CODEX_HOME: source.home });
}

export type CodexExecutionPlan = ProviderExecutionPlan<
  Readonly<{
    platform: string;
    source: CodexCredentialSource;
    command: string;
    args: readonly string[];
    cwd: string;
    environment: readonly EnvironmentLayer[];
    leaseMode: 'job-exclusive';
  }>,
  Readonly<{ sessionId: string }>,
  Readonly<{ processEnvironment: readonly EnvironmentLayer[] }>
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

function routingLayer(source: CodexCredentialSource, platform: string): EnvironmentLayer {
  const values = codexRoutingEnv(source);
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

export function compileCodexProcessEnvironment(plan: CodexExecutionPlan): Readonly<Record<string, string>> {
  return compileEnvironmentLayers([...plan.host.environment, ...plan.turn.processEnvironment], {
    platform: plan.host.platform,
    lifetimes: allExecutionLifetimes(),
  });
}

export function compileCodexTurnEnvironment(plan: CodexExecutionPlan): Readonly<Record<string, string>> {
  return compileEnvironmentLayers(plan.turn.processEnvironment, {
    platform: plan.host.platform,
    lifetimes: new Set(['turn']),
  });
}

export function compileCodexHostEnvironment(host: CodexExecutionPlan['host']): Readonly<Record<string, string>> {
  return compileEnvironmentLayers(host.environment, {
    platform: host.platform,
    lifetimes: hostExecutionLifetime(),
  });
}

function buildCodexHost(options: {
  source: CodexCredentialSource;
  request: ProviderRequest;
  persistedContinuity?: ProviderContinuityBlob;
  baseEnv: Readonly<Record<string, string>>;
  platform: string;
}): CodexExecutionPlan['host'] {
  return Object.freeze({
    platform: options.platform,
    source: options.source,
    command: 'codex',
    args: Object.freeze(['app-server']),
    cwd: resolveCodexHostCwd(options.request.cwd, options.persistedContinuity),
    environment: Object.freeze([
      baseLayer(options.baseEnv, options.platform),
      routingLayer(options.source, options.platform),
      processSettingsLayer(options.request.coralEnv, options.platform),
    ]),
    leaseMode: 'job-exclusive' as const,
  });
}

export function buildCodexExecutionPlan(options: {
  source: CodexCredentialSource;
  request: ProviderRequest;
  persistedContinuity?: ProviderContinuityBlob;
  baseEnv: Readonly<Record<string, string>>;
  protectedEnv?: Readonly<Record<string, string>>;
  platform: string;
}): {
  readonly plan: CodexExecutionPlan;
  readonly appServerTurnEnv: Readonly<Record<string, string>>;
  prepareCliRequest(request: ProviderCliRequest): ProviderCliRequest;
} {
  const plan: CodexExecutionPlan = Object.freeze({
    host: buildCodexHost(options),
    session: Object.freeze({ sessionId: options.request.sessionId }),
    turn: Object.freeze({
      processEnvironment: Object.freeze([
        turnAuthorityLayer(options.request, options.protectedEnv ?? {}, options.platform),
        requestLayer(options.request.coralEnv, options.platform),
      ]),
    }),
  });
  const processEnv = compileCodexProcessEnvironment(plan);
  const turnEnv = compileCodexTurnEnvironment(plan);
  return {
    plan,
    appServerTurnEnv: turnEnv,
    prepareCliRequest: (request) => ({
      ...request,
      command: windowsCommandName(request.command, options.platform),
      exactEnv: { ...processEnv },
      extraEnv: undefined,
    }),
  };
}

export function buildCodexPreflightRuntime(
  input: ProviderPreflightInput<CodexCredentialSource>,
): ProviderPreflightRuntime<CodexCredentialSource> {
  const exactEnv = compileEnvironmentLayers(
    [
      baseLayer(input.baseEnv, input.platform),
      routingLayer(input.credentialSource, input.platform),
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
    credentialSource: input.credentialSource,
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
