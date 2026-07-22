import type { ProviderPreflightInput, ProviderPreflightRuntime, ProviderRequest } from '../contract.js';
import { buildExactProviderEnv } from '../execution-context.js';
import { shouldUseWindowsCommandShell, windowsCommandName } from '../../infra/windows-shell.js';
import type { ProviderCliRequest } from '../protocol.js';
import { CODEX_ALLOWED_REQUEST_ENV_KEYS, CODEX_PROTECTED_REQUEST_ENV_KEYS } from './credential-policy.js';

export type CodexCredentialSource = {
  readonly home: string;
};

export function codexRoutingEnv(source: CodexCredentialSource): Readonly<Record<string, string>> {
  return Object.freeze({ CODEX_HOME: source.home });
}

export type CodexExecutionContext = {
  readonly source: CodexCredentialSource;
  readonly appServerEnv: Readonly<Record<string, string>>;
  readonly platform: string;
};

export function buildCodexExecutionContext(options: {
  source: CodexCredentialSource;
  request: ProviderRequest;
  baseEnv: Readonly<Record<string, string>>;
  protectedEnv?: Readonly<Record<string, string>>;
  platform: string;
}): { readonly context: CodexExecutionContext; prepareCliRequest(request: ProviderCliRequest): ProviderCliRequest } {
  const childAuthority = {
    CORAL_CHILD: '1',
    CORAL_SESSION_ID: options.request.sessionId,
    ...(options.protectedEnv ?? {}),
  };
  const appServerEnv = buildExactProviderEnv({
    baseEnv: options.baseEnv,
    requestEnv: options.request.coralEnv,
    protectedEnv: childAuthority,
    routingEnv: codexRoutingEnv(options.source),
    protectedRequestKeys: CODEX_PROTECTED_REQUEST_ENV_KEYS,
    allowedRequestKeys: CODEX_ALLOWED_REQUEST_ENV_KEYS,
    platform: options.platform,
  });
  return {
    context: {
      source: options.source,
      appServerEnv,
      platform: options.platform,
    },
    prepareCliRequest: (request) => ({
      ...request,
      command: windowsCommandName(request.command, options.platform),
      exactEnv: { ...appServerEnv },
      extraEnv: undefined,
    }),
  };
}

export function buildCodexPreflightRuntime(
  input: ProviderPreflightInput<CodexCredentialSource>,
): ProviderPreflightRuntime<CodexCredentialSource> {
  const exactEnv = buildExactProviderEnv({
    baseEnv: input.baseEnv,
    requestEnv: input.requestEnv,
    routingEnv: codexRoutingEnv(input.credentialSource),
    protectedRequestKeys: CODEX_PROTECTED_REQUEST_ENV_KEYS,
    allowedRequestKeys: CODEX_ALLOWED_REQUEST_ENV_KEYS,
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
