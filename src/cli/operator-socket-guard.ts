import { createServer, type Server } from 'node:net';

import { createCoordinatorSocketAddressClaim } from '../coordinator/socket-address-claim.js';
import { CoralSetupError, documentedCoralSetupError } from '../runtime/errors.js';
import type { Runtime } from '../runtime/ports.js';
import { bindPublishedSocket, bindSocket } from '../transport/ipc/server.js';

export interface OperatorSocketGuard {
  release(): Promise<void>;
}

type AcquireOperatorSocketGuardOptions = {
  readonly runtime: Pick<Runtime, 'env' | 'flavor' | 'paths' | 'storage'>;
  readonly operation: string;
  readonly retryCommand: string;
};

export async function acquireOperatorSocketGuard({
  runtime,
  operation,
  retryCommand,
}: AcquireOperatorSocketGuardOptions): Promise<OperatorSocketGuard> {
  const socketPath = runtime.paths.coral.coordinator.socketPath;
  let attemptedSocketPath = socketPath;
  try {
    const addressClaim = createCoordinatorSocketAddressClaim(runtime, operation);
    const binding = await addressClaim.acquire(async (additionalSocketPaths, publishedSocketAddresses) => {
      const servers: Server[] = [];
      try {
        const addresses = [
          ...[socketPath, ...additionalSocketPaths].map((path) => ({ kind: 'computed' as const, path })),
          ...publishedSocketAddresses.map((address) => ({
            kind: 'published' as const,
            path: address.socketPath,
            address,
          })),
        ];
        for (const address of addresses) {
          attemptedSocketPath = address.path;
          const server = createServer();
          const result =
            address.kind === 'published'
              ? await bindPublishedSocket(server, address.address)
              : await bindSocket(server, address.path);
          if (result.kind === 'incumbent') {
            await closeSocketGuards(servers);
            return { kind: 'incumbent', socketPath: address.path };
          }
          servers.push(server);
        }
      } catch (error: unknown) {
        try {
          await closeSocketGuards(servers);
        } catch (closeError: unknown) {
          throw new AggregateError([error, closeError], 'Operator socket guard acquisition and rollback failed', {
            cause: closeError,
          });
        }
        throw error;
      }
      return { kind: 'held', release: () => closeSocketGuards(servers) };
    });
    if (binding.kind === 'incumbent') {
      throw documentedCoralSetupError({
        code: 'coordinator_socket_in_use',
        socketPath: binding.socketPath,
        flavor: runtime.flavor,
        operation,
        retryCommand,
      });
    }
    return binding;
  } catch (error: unknown) {
    // Re-wrapping a documented refusal would put "could not observe" and "observed and refused" back under
    // one code and one exit.
    if (error instanceof CoralSetupError) throw error;
    throw documentedCoralSetupError({
      code: 'coordinator_socket_bind_failed',
      socketPath: attemptedSocketPath,
      flavor: runtime.flavor,
      operation,
      retryCommand,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

async function closeSocketGuards(servers: readonly Server[]): Promise<void> {
  let firstError: unknown;
  for (const server of [...servers].reverse()) {
    try {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    } catch (error: unknown) {
      firstError ??= error;
    }
  }
  if (firstError === undefined) return;
  if (firstError instanceof Error) throw firstError;
  throw new Error('Operator socket guard release failed.', { cause: firstError });
}
