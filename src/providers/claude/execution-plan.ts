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
import { CLAUDE_ALLOWED_REQUEST_ENV_KEYS, CLAUDE_PROTECTED_REQUEST_ENV_KEYS } from './credential-policy.js';
import type { StoragePort } from '../../infra/port-types.js';
import { resolveClaudeBrokerEntrypoint, type ClaudeBrokerHostPlan } from './request-mapping.js';
import { claudeTransportEnv } from './transport-mode.js';
import type { resolveClaudeTransportMode } from './transport-mode.js';
import type { CanonicalWorkDir } from '../../runtime/canonical-work-dir.js';

export type ClaudeProviderAccess =
  | {
      readonly configDir: string;
      readonly projectsRoot: string;
      readonly routing: { readonly kind: 'config-dir' };
    }
  | {
      readonly configDir: string;
      readonly projectsRoot: string;
      readonly routing: { readonly kind: 'default-home'; readonly homeDir: string };
    };

export function claudeRoutingEnv(access: ClaudeProviderAccess): Readonly<Record<string, string>> {
  return access.routing.kind === 'config-dir'
    ? Object.freeze({ CLAUDE_CONFIG_DIR: access.configDir })
    : Object.freeze({ HOME: access.routing.homeDir });
}

export type ClaudeExecutionPlan = ProviderExecutionPlan<
  Readonly<{
    platform: string;
    broker: Readonly<{
      command: string;
      args: readonly string[];
      cwd: CanonicalWorkDir;
      transportMode: ReturnType<typeof resolveClaudeTransportMode>;
      environment: readonly EnvironmentLayer[];
    }>;
    controller: Readonly<{ access: ClaudeProviderAccess; environment: readonly EnvironmentLayer[] }>;
  }>,
  Readonly<{ sessionId: string; projectsRoot: string }>,
  Readonly<{ controllerEnvironment: readonly EnvironmentLayer[] }>
>;

export function claudeBaseLayer(values: Readonly<Record<string, string>>, platform: string): EnvironmentLayer {
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

export function claudeRoutingLayer(access: ClaudeProviderAccess, platform: string): EnvironmentLayer {
  const values = claudeRoutingEnv(access);
  return environmentLayer(
    {
      name: 'claude-account-routing',
      lifetime: 'host',
      provenance: 'verified-provider-binding',
      values,
      writes: new Set(Object.keys(values)),
      protects: new Set([...Object.keys(values), ...CLAUDE_PROTECTED_REQUEST_ENV_KEYS]),
    },
    platform,
  );
}

export function claudeBrokerSettingsLayer(
  transportMode: ReturnType<typeof resolveClaudeTransportMode>,
  platform: string,
): EnvironmentLayer {
  const values = claudeTransportEnv(transportMode);
  return environmentLayer(
    {
      name: 'claude-broker-transport',
      lifetime: 'host',
      provenance: 'provider-request-stable-transport',
      values,
      writes: Object.keys(values),
      protects: Object.keys(values),
    },
    platform,
  );
}

function processSettingsLayer(values: Readonly<Record<string, string>>, platform: string): EnvironmentLayer {
  const allowed = new Set([...EXECUTION_ENV_ALLOWLIST, ...CORAL_PROCESS_ENV_KEYS]);
  return environmentLayer(
    {
      name: 'claude-controller-process-settings',
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
  const allowed = new Set([
    ...CORAL_TURN_ENV_KEYS,
    ...[...CLAUDE_ALLOWED_REQUEST_ENV_KEYS].filter((key) => key !== 'CORAL_CLAUDE_TRANSPORT'),
  ]);
  return environmentLayer(
    {
      name: 'claude-turn-settings',
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

export function compileClaudeBrokerEnvironment(plan: ClaudeExecutionPlan): Readonly<Record<string, string>> {
  return compileClaudeBrokerHost(plan.host).environment;
}

export function compileClaudeBrokerHost(
  host: Pick<ClaudeExecutionPlan['host'], 'platform' | 'broker'>,
): ClaudeBrokerHostPlan {
  const environment = compileEnvironmentLayers(host.broker.environment, {
    platform: host.platform,
    lifetimes: hostExecutionLifetime(),
  });
  return Object.freeze({
    command: host.broker.command,
    args: host.broker.args,
    cwd: host.broker.cwd,
    environment,
    transportMode: host.broker.transportMode,
  });
}

export function createClaudeBrokerHost(options: {
  readonly cwd: CanonicalWorkDir;
  readonly baseEnv: Readonly<Record<string, string>>;
  readonly platform: string;
  readonly storage: Pick<StoragePort, 'existsSync'>;
  readonly transportMode: ReturnType<typeof resolveClaudeTransportMode>;
}): ClaudeExecutionPlan['host']['broker'] {
  return Object.freeze({
    command: process.execPath,
    args: Object.freeze([resolveClaudeBrokerEntrypoint(options.storage)]),
    cwd: options.cwd,
    transportMode: options.transportMode,
    environment: Object.freeze([
      claudeBaseLayer(options.baseEnv, options.platform),
      claudeBrokerSettingsLayer(options.transportMode, options.platform),
    ]),
  });
}

export function buildClaudeHost(options: {
  readonly access: ClaudeProviderAccess;
  readonly request: Pick<ProviderRequest, 'cwd' | 'coralEnv'>;
  readonly baseEnv: Readonly<Record<string, string>>;
  readonly platform: string;
  readonly storage: Pick<StoragePort, 'existsSync'>;
  readonly transportMode: ReturnType<typeof resolveClaudeTransportMode>;
}): ClaudeExecutionPlan['host'] {
  return Object.freeze({
    platform: options.platform,
    broker: createClaudeBrokerHost({
      cwd: options.request.cwd,
      baseEnv: options.baseEnv,
      platform: options.platform,
      storage: options.storage,
      transportMode: options.transportMode,
    }),
    controller: buildClaudeControllerHost({
      access: options.access,
      coralEnv: options.request.coralEnv,
      baseEnv: options.baseEnv,
      platform: options.platform,
    }),
  });
}

export function buildClaudeControllerHost(options: {
  readonly access: ClaudeProviderAccess;
  readonly coralEnv: Readonly<Record<string, string>>;
  readonly baseEnv: Readonly<Record<string, string>>;
  readonly platform: string;
}): ClaudeExecutionPlan['host']['controller'] {
  return Object.freeze({
    access: options.access,
    environment: Object.freeze([
      claudeBaseLayer(options.baseEnv, options.platform),
      claudeRoutingLayer(options.access, options.platform),
      processSettingsLayer(options.coralEnv, options.platform),
    ]),
  });
}

export function compileClaudeControllerEnvironment(plan: ClaudeExecutionPlan): Readonly<Record<string, string>> {
  return compileEnvironmentLayers([...plan.host.controller.environment, ...plan.turn.controllerEnvironment], {
    platform: plan.host.platform,
    lifetimes: allExecutionLifetimes(),
  });
}

export function buildClaudeExecutionPlan(options: {
  access: ClaudeProviderAccess;
  hostPlan: ClaudeExecutionPlan['host'];
  request: ProviderRequest;
  baseEnv: Readonly<Record<string, string>>;
  protectedEnv?: Readonly<Record<string, string>>;
  platform: string;
  storage: Pick<StoragePort, 'existsSync'>;
}): {
  readonly session: ClaudeExecutionPlan['session'];
  readonly turn: ClaudeExecutionPlan['turn'];
} {
  const plan: ClaudeExecutionPlan = Object.freeze({
    host: options.hostPlan,
    session: Object.freeze({ sessionId: options.request.sessionId, projectsRoot: options.access.projectsRoot }),
    turn: Object.freeze({
      controllerEnvironment: Object.freeze([
        turnAuthorityLayer(options.request, options.protectedEnv ?? {}, options.platform),
        requestLayer(options.request.coralEnv, options.platform),
      ]),
    }),
  });
  return {
    session: plan.session,
    turn: plan.turn,
  };
}

export function buildClaudePreflightRuntime(
  input: ProviderPreflightInput<ClaudeProviderAccess>,
): ProviderPreflightRuntime<ClaudeProviderAccess> {
  const layers = [
    claudeBaseLayer(input.baseEnv, input.platform),
    claudeRoutingLayer(input.access, input.platform),
    processSettingsLayer(input.requestEnv, input.platform),
    requestLayer(input.requestEnv, input.platform),
  ];
  const exactEnv = compileEnvironmentLayers(layers, {
    platform: input.platform,
    lifetimes: allExecutionLifetimes(),
  });
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
