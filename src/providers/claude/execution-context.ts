import type { ProviderPreflightInput, ProviderPreflightRuntime, ProviderRequest } from '../contract.js';
import { buildExactProviderEnv } from '../execution-context.js';
import { shouldUseWindowsCommandShell, windowsCommandName } from '../../infra/windows-shell.js';
import type { ProviderCliRequest } from '../protocol.js';
import { CLAUDE_ALLOWED_REQUEST_ENV_KEYS, CLAUDE_PROTECTED_REQUEST_ENV_KEYS } from './credential-policy.js';

export type ClaudeCredentialSource =
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

export function claudeRoutingEnv(source: ClaudeCredentialSource): Readonly<Record<string, string>> {
  return source.routing.kind === 'config-dir'
    ? Object.freeze({ CLAUDE_CONFIG_DIR: source.configDir })
    : Object.freeze({ HOME: source.routing.homeDir });
}

export type ClaudeExecutionContext = {
  readonly source: ClaudeCredentialSource;
  readonly brokerEnv: Readonly<Record<string, string>>;
  readonly controllerEnv: Readonly<Record<string, string>>;
  readonly projectsRoot: string;
};

export function buildClaudeExecutionContext(options: {
  source: ClaudeCredentialSource;
  request: ProviderRequest;
  baseEnv: Readonly<Record<string, string>>;
  protectedEnv?: Readonly<Record<string, string>>;
  platform: string;
}): { readonly context: ClaudeExecutionContext; prepareCliRequest(request: ProviderCliRequest): ProviderCliRequest } {
  const childAuthority = {
    CORAL_CHILD: '1',
    CORAL_SESSION_ID: options.request.sessionId,
    ...(options.protectedEnv ?? {}),
  };
  const controllerEnv = buildExactProviderEnv({
    baseEnv: options.baseEnv,
    requestEnv: options.request.coralEnv,
    protectedEnv: childAuthority,
    routingEnv: claudeRoutingEnv(options.source),
    protectedRequestKeys: CLAUDE_PROTECTED_REQUEST_ENV_KEYS,
    allowedRequestKeys: CLAUDE_ALLOWED_REQUEST_ENV_KEYS,
    platform: options.platform,
  });
  return {
    context: {
      source: options.source,
      brokerEnv: buildExactProviderEnv({
        baseEnv: options.baseEnv,
        requestEnv: options.request.coralEnv,
        allowedRequestKeys: CLAUDE_ALLOWED_REQUEST_ENV_KEYS,
        platform: options.platform,
      }),
      controllerEnv,
      projectsRoot: options.source.projectsRoot,
    },
    prepareCliRequest: (request) => ({
      ...request,
      command: windowsCommandName(request.command, options.platform),
      exactEnv: { ...controllerEnv },
      extraEnv: undefined,
    }),
  };
}

export function buildClaudePreflightRuntime(
  input: ProviderPreflightInput<ClaudeCredentialSource>,
): ProviderPreflightRuntime<ClaudeCredentialSource> {
  const exactEnv = buildExactProviderEnv({
    baseEnv: input.baseEnv,
    requestEnv: input.requestEnv,
    routingEnv: claudeRoutingEnv(input.credentialSource),
    protectedRequestKeys: CLAUDE_PROTECTED_REQUEST_ENV_KEYS,
    allowedRequestKeys: CLAUDE_ALLOWED_REQUEST_ENV_KEYS,
    platform: input.platform,
  });
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
