import { InvalidArgumentError, type Command } from 'commander';

import { assertNever } from '../../infra/error-format.js';
import { processIncarnationSchema, type ProcessIncarnation } from '../../infra/node-process.js';
import { providerProxyRoleIdentitySchema, type ProviderProxyRoleIdentity } from '../../provider-proxy/protocol.js';
import { emitError } from '../emit.js';

type ProviderProxyRoleActionFailure =
  | Readonly<{
      kind: 'identity-mismatch';
      roleIdentity: ProviderProxyRoleIdentity;
      observedIncarnation: ProcessIncarnation;
    }>
  | Readonly<{
      kind: 'identity-unobservable';
      roleIdentity: ProviderProxyRoleIdentity;
      reason: 'incarnation-unavailable';
    }>
  | Readonly<{ kind: 'refused'; roleIdentity: ProviderProxyRoleIdentity; reason: string }>
  | Readonly<{ kind: 'unreachable'; roleIdentity: ProviderProxyRoleIdentity; reason: string }>;

export type ProviderProxyRoleTerminationResult =
  | Readonly<{ kind: 'abandoned'; roleIdentity: ProviderProxyRoleIdentity }>
  | ProviderProxyRoleActionFailure;

export type ProviderProxyRoleReapRetryResult =
  | Readonly<{ kind: 'reap-retry-requested'; roleIdentity: ProviderProxyRoleIdentity }>
  | ProviderProxyRoleActionFailure;

export type ProviderProxyRoleAbandonmentAttempt =
  | Readonly<{ kind: 'abandoned' }>
  | Readonly<{ kind: 'refused'; reason: string }>
  | Readonly<{ kind: 'unreachable'; reason: string }>;

export type ProviderProxyRoleReapRetryAttempt =
  | Readonly<{ kind: 'reap-retry-requested' }>
  | Readonly<{ kind: 'refused'; reason: string }>
  | Readonly<{ kind: 'unreachable'; reason: string }>;

export interface ProviderProxyRoleTerminationCommandOperations {
  terminate(roleIdentity: ProviderProxyRoleIdentity): Promise<ProviderProxyRoleTerminationResult>;
  retryReap(roleIdentity: ProviderProxyRoleIdentity): Promise<ProviderProxyRoleReapRetryResult>;
}

export function createProviderProxyRoleTerminationCommandOperations(options: {
  platform: NodeJS.Platform;
  readProcessIncarnation(pid: number, platform: NodeJS.Platform): ProcessIncarnation | null;
  abandon(roleIdentity: ProviderProxyRoleIdentity): Promise<ProviderProxyRoleAbandonmentAttempt>;
  retryReap(roleIdentity: ProviderProxyRoleIdentity): Promise<ProviderProxyRoleReapRetryAttempt>;
}): ProviderProxyRoleTerminationCommandOperations {
  const observeRole = (
    input: ProviderProxyRoleIdentity,
  ):
    | Readonly<{ kind: 'matched'; roleIdentity: ProviderProxyRoleIdentity }>
    | Extract<ProviderProxyRoleActionFailure, { kind: 'identity-mismatch' | 'identity-unobservable' }> => {
    const roleIdentity = providerProxyRoleIdentitySchema.parse(input);
    let observedIncarnation: ProcessIncarnation | null;
    try {
      observedIncarnation = options.readProcessIncarnation(roleIdentity.pid, options.platform);
    } catch {
      observedIncarnation = null;
    }
    if (observedIncarnation === null) {
      return { kind: 'identity-unobservable', roleIdentity, reason: 'incarnation-unavailable' };
    }
    if (observedIncarnation !== roleIdentity.incarnation) {
      return { kind: 'identity-mismatch', roleIdentity, observedIncarnation };
    }
    return { kind: 'matched', roleIdentity };
  };

  return {
    terminate: async (input) => {
      const observed = observeRole(input);
      if (observed.kind !== 'matched') return observed;
      return { ...(await options.abandon(observed.roleIdentity)), roleIdentity: observed.roleIdentity };
    },
    retryReap: async (input) => {
      const observed = observeRole(input);
      if (observed.kind !== 'matched') return observed;
      return { ...(await options.retryReap(observed.roleIdentity)), roleIdentity: observed.roleIdentity };
    },
  };
}

function parseRole(value: string): ProviderProxyRoleIdentity['role'] {
  const parsed = providerProxyRoleIdentitySchema.shape.role.safeParse(value);
  if (!parsed.success) throw new InvalidArgumentError("Role must be 'guardian' or 'reaper'.");
  return parsed.data;
}

function parsePid(value: string): number {
  if (!/^\d+$/u.test(value)) throw new InvalidArgumentError('PID must be a positive safe integer.');
  const parsed = providerProxyRoleIdentitySchema.shape.pid.safeParse(Number(value));
  if (!parsed.success) throw new InvalidArgumentError('PID must be a positive safe integer.');
  return parsed.data;
}

function parseIncarnation(value: string): ProcessIncarnation {
  const parsed = processIncarnationSchema.safeParse(value);
  if (!parsed.success) throw new InvalidArgumentError('Incarnation must be a non-empty process identity token.');
  return parsed.data;
}

function quoteShellArgument(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function formatProviderProxyRoleTerminationCommand(roleIdentity: ProviderProxyRoleIdentity): string {
  const parsed = providerProxyRoleIdentitySchema.parse(roleIdentity);
  return (
    `coral-cli backend provider-proxy-set terminate-role --role ${parsed.role} --pid ${parsed.pid} ` +
    `--incarnation ${quoteShellArgument(parsed.incarnation)}`
  );
}

export function formatProviderProxyRoleReapRetryCommand(roleIdentity: ProviderProxyRoleIdentity): string {
  const parsed = providerProxyRoleIdentitySchema.parse(roleIdentity);
  return (
    `coral-cli backend provider-proxy-set retry-role-reap --role ${parsed.role} --pid ${parsed.pid} ` +
    `--incarnation ${quoteShellArgument(parsed.incarnation)}`
  );
}

export function formatProviderProxyRoleTerminationResult(result: ProviderProxyRoleTerminationResult): string {
  const { role, pid, incarnation } = result.roleIdentity;
  switch (result.kind) {
    case 'abandoned':
      return `Authorized ${role} role pid ${pid} to finalize its unattributable containment after re-observing incarnation ${JSON.stringify(incarnation)}. The abandonment request sent no process signal and minted no absence.`;
    case 'identity-mismatch':
      return `Refusing to abandon ${role} role pid ${pid}: observed incarnation ${JSON.stringify(result.observedIncarnation)} does not match recorded incarnation ${JSON.stringify(incarnation)}. This command does not send process signals.`;
    case 'identity-unobservable':
      return `Refusing to abandon ${role} role pid ${pid}: its current incarnation could not be observed. This command does not send process signals.`;
    case 'refused':
      return `Refusing to abandon ${role} role pid ${pid}: ${result.reason} This command does not send process signals.`;
    case 'unreachable':
      return `Could not ask ${role} role pid ${pid} to abandon its unattributable containment: ${result.reason} This command does not send process signals.`;
    default:
      return assertNever(result);
  }
}

export function formatProviderProxyRoleReapRetryResult(result: ProviderProxyRoleReapRetryResult): string {
  const { role, pid, incarnation } = result.roleIdentity;
  switch (result.kind) {
    case 'reap-retry-requested':
      return `Requested another containment reap from ${role} role pid ${pid} after re-observing incarnation ${JSON.stringify(incarnation)}. The role retains containment ownership unless it confirms absence.`;
    case 'identity-mismatch':
      return `Refusing to retry containment reap for ${role} role pid ${pid}: observed incarnation ${JSON.stringify(result.observedIncarnation)} does not match recorded incarnation ${JSON.stringify(incarnation)}. No signal was sent.`;
    case 'identity-unobservable':
      return `Refusing to retry containment reap for ${role} role pid ${pid}: its current incarnation could not be observed. No signal was sent.`;
    case 'refused':
      return `Refusing to retry containment reap for ${role} role pid ${pid}: ${result.reason} No signal was sent.`;
    case 'unreachable':
      return `Could not request another containment reap from ${role} role pid ${pid}: ${result.reason}`;
    default:
      return assertNever(result);
  }
}

export function registerProviderProxyRoleTerminationCommand(
  providerProxySetCommand: Command,
  operations: ProviderProxyRoleTerminationCommandOperations,
): void {
  const withRoleIdentity = (command: Command): Command =>
    command
      .requiredOption('--role <role>', 'Recorded role shown by backend status', parseRole)
      .requiredOption('--pid <pid>', 'Recorded pid shown by backend status', parsePid)
      .requiredOption('--incarnation <incarnation>', 'Recorded incarnation shown by backend status', parseIncarnation);
  const exitCodeFor = (result: ProviderProxyRoleTerminationResult | ProviderProxyRoleReapRetryResult): 0 | 1 | 75 => {
    if (result.kind === 'abandoned' || result.kind === 'reap-retry-requested') return 0;
    return result.kind === 'identity-mismatch' || result.kind === 'refused' ? 1 : 75;
  };

  withRoleIdentity(
    providerProxySetCommand.command('terminate-role').description('Abandon one exact unattributable role hold'),
  ).action(async (options: ProviderProxyRoleIdentity) => {
    try {
      const result = await operations.terminate(providerProxyRoleIdentitySchema.parse(options));
      const exitCode = exitCodeFor(result);
      (exitCode === 0 ? process.stdout : process.stderr).write(`${formatProviderProxyRoleTerminationResult(result)}\n`);
      process.exitCode = exitCode;
    } catch (error: unknown) {
      emitError(error);
    }
  });

  withRoleIdentity(
    providerProxySetCommand.command('retry-role-reap').description('Retry one exact failed role reap'),
  ).action(async (options: ProviderProxyRoleIdentity) => {
    try {
      const result = await operations.retryReap(providerProxyRoleIdentitySchema.parse(options));
      const exitCode = exitCodeFor(result);
      (exitCode === 0 ? process.stdout : process.stderr).write(`${formatProviderProxyRoleReapRetryResult(result)}\n`);
      process.exitCode = exitCode;
    } catch (error: unknown) {
      emitError(error);
    }
  });
}
