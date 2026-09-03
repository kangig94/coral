import { InvalidArgumentError, type Command } from 'commander';
import { z } from 'zod';

import {
  incarnationMayAuthorizeSignal,
  probeProcessIncarnation,
  processIncarnationSchema,
  type ProcessIncarnation,
} from '../../infra/node-process.js';
import { assertNever } from '../../infra/error-format.js';
import { emitError } from '../emit.js';

const providerProxyRoleIdentitySchema = z
  .object({
    role: z.enum(['guardian', 'reaper']),
    pid: z.number().int().positive().safe(),
    incarnation: processIncarnationSchema,
  })
  .strict();

export type ProviderProxyRoleIdentity = Readonly<z.output<typeof providerProxyRoleIdentitySchema>>;

export type ProviderProxyRoleTerminationResult =
  | Readonly<{ kind: 'signalled'; roleIdentity: ProviderProxyRoleIdentity }>
  | Readonly<{
      kind: 'identity-mismatch';
      roleIdentity: ProviderProxyRoleIdentity;
      observedIncarnation: ProcessIncarnation;
    }>
  | Readonly<{
      kind: 'identity-unobservable';
      roleIdentity: ProviderProxyRoleIdentity;
      reason: 'incarnation-unavailable' | 'platform-cannot-authorize-signal';
    }>;

export interface ProviderProxyRoleTerminationCommandOperations {
  terminate(roleIdentity: ProviderProxyRoleIdentity): ProviderProxyRoleTerminationResult;
}

export function createProviderProxyRoleTerminationCommandOperations(
  options: {
    platform?: NodeJS.Platform;
    readProcessIncarnation?: (pid: number, platform: NodeJS.Platform) => ProcessIncarnation | null;
    signal?: (pid: number, signal: NodeJS.Signals) => void;
  } = {},
): ProviderProxyRoleTerminationCommandOperations {
  const platform = options.platform ?? process.platform;
  const readProcessIncarnation = options.readProcessIncarnation ?? probeProcessIncarnation;
  const signal = options.signal ?? ((pid, processSignal) => void process.kill(pid, processSignal));

  return {
    terminate: (input) => {
      const roleIdentity = providerProxyRoleIdentitySchema.parse(input);
      if (!incarnationMayAuthorizeSignal(platform)) {
        return { kind: 'identity-unobservable', roleIdentity, reason: 'platform-cannot-authorize-signal' };
      }

      let observedIncarnation: ProcessIncarnation | null;
      try {
        observedIncarnation = readProcessIncarnation(roleIdentity.pid, platform);
      } catch {
        observedIncarnation = null;
      }
      if (observedIncarnation === null) {
        return { kind: 'identity-unobservable', roleIdentity, reason: 'incarnation-unavailable' };
      }
      if (observedIncarnation !== roleIdentity.incarnation) {
        return { kind: 'identity-mismatch', roleIdentity, observedIncarnation };
      }

      signal(roleIdentity.pid, 'SIGTERM');
      return { kind: 'signalled', roleIdentity };
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

export function formatProviderProxyRoleTerminationResult(result: ProviderProxyRoleTerminationResult): string {
  const { role, pid, incarnation } = result.roleIdentity;
  switch (result.kind) {
    case 'signalled':
      return `Sent SIGTERM to ${role} role pid ${pid} after re-observing its recorded incarnation ${JSON.stringify(incarnation)}.`;
    case 'identity-mismatch':
      return `Refusing to signal ${role} role pid ${pid}: observed incarnation ${JSON.stringify(result.observedIncarnation)} does not match recorded incarnation ${JSON.stringify(incarnation)}. No signal was sent.`;
    case 'identity-unobservable':
      return result.reason === 'platform-cannot-authorize-signal'
        ? `Refusing to signal ${role} role pid ${pid}: this platform cannot use process incarnation equality to authorize a signal. No signal was sent.`
        : `Refusing to signal ${role} role pid ${pid}: its current incarnation could not be observed. No signal was sent.`;
    default:
      return assertNever(result);
  }
}

export function registerProviderProxyRoleTerminationCommand(
  providerProxySetCommand: Command,
  operations: ProviderProxyRoleTerminationCommandOperations,
): void {
  providerProxySetCommand
    .argument('[operator-action]', "Operator action; 'terminate-role' signals one exact role identity")
    .option('--role <role>', 'Recorded role shown by backend status', parseRole)
    .option('--pid <pid>', 'Recorded pid shown by backend status', parsePid)
    .option('--incarnation <incarnation>', 'Recorded incarnation shown by backend status', parseIncarnation)
    .action(
      (
        operatorAction: string | undefined,
        options: {
          role?: ProviderProxyRoleIdentity['role'];
          pid?: number;
          incarnation?: ProcessIncarnation;
        },
      ) => {
        try {
          if (operatorAction !== 'terminate-role') {
            throw new InvalidArgumentError("Provider-proxy set operator action must be 'terminate-role'.");
          }
          const parsed = providerProxyRoleIdentitySchema.safeParse(options);
          if (!parsed.success) {
            throw new InvalidArgumentError('Options --role, --pid, and --incarnation are required.');
          }
          const result = operations.terminate(parsed.data);
          const exitCode = result.kind === 'signalled' ? 0 : result.kind === 'identity-mismatch' ? 1 : 75;
          (exitCode === 0 ? process.stdout : process.stderr).write(
            `${formatProviderProxyRoleTerminationResult(result)}\n`,
          );
          process.exitCode = exitCode;
        } catch (error: unknown) {
          emitError(error);
        }
      },
    );
}
