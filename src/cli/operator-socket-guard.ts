import { createServer, type Server } from 'node:net';

import type { BuildFlavor } from '../infra/build-flavor.js';
import { CoralSetupError, documentedCoralSetupError } from '../runtime/errors.js';
import { bindSocket } from '../transport/ipc/server.js';

export interface OperatorSocketGuard {
  release(): Promise<void>;
}

type AcquireOperatorSocketGuardOptions = {
  readonly socketPath: string;
  readonly flavor: BuildFlavor;
  readonly operation: string;
  readonly retryCommand: string;
};

export async function acquireOperatorSocketGuard({
  socketPath,
  flavor,
  operation,
  retryCommand,
}: AcquireOperatorSocketGuardOptions): Promise<OperatorSocketGuard> {
  const server = createServer();
  let binding: Awaited<ReturnType<typeof bindSocket>>;
  try {
    binding = await bindSocket(server, socketPath);
  } catch (error: unknown) {
    // A bind failure this command cannot classify becomes the generic code below. One that already carries a
    // documented code carries its own remediation and its own exit class with it, and re-wrapping would put
    // "could not observe" and "observed and refused" back under one code and one exit.
    if (error instanceof CoralSetupError) throw error;
    throw documentedCoralSetupError({
      code: 'coordinator_socket_bind_failed',
      socketPath,
      flavor,
      operation,
      retryCommand,
      cause: error instanceof Error ? error.message : String(error),
    });
  }

  if (binding.kind === 'incumbent') {
    throw documentedCoralSetupError({
      code: 'coordinator_socket_in_use',
      socketPath,
      flavor,
      operation,
      retryCommand,
    });
  }

  return { release: () => closeSocketGuard(server) };
}

async function closeSocketGuard(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
