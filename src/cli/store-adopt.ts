import { createServer, type Server } from 'node:net';

import type { BuildFlavor } from '../infra/build-flavor.js';
import { documentedCoralSetupError } from '../runtime/errors.js';
import { createRealRuntime } from '../runtime/real.js';
import {
  adoptLegacyStore,
  type AdoptionSocketGuard,
  type LegacyStoreAdoptionResult,
} from '../store/legacy-store-adoption.js';
import { currentCoralStoreFormat } from '../store-format.js';
import { bindSocket } from '../transport/ipc/server.js';

async function closeSocketGuard(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

export async function acquireStoreAdoptionSocketGuard(
  socketPath: string,
  flavor: BuildFlavor,
): Promise<AdoptionSocketGuard> {
  const server = createServer();
  const binding = await bindSocket(server, socketPath);
  if (binding.kind === 'incumbent') {
    throw documentedCoralSetupError({
      code: 'legacy_source_not_quiescent',
      flavor,
      holder: 'current-generation coordinator socket',
    });
  }
  return { release: () => closeSocketGuard(server) };
}

export function adoptLegacyStoreLocal(flavor: BuildFlavor): Promise<LegacyStoreAdoptionResult> {
  return adoptLegacyStore({
    runtime: createRealRuntime(flavor),
    storeFormat: currentCoralStoreFormat(),
    acquireSocketGuard: acquireStoreAdoptionSocketGuard,
  });
}
