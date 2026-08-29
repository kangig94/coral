import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  readDiscoveryRecordDisposition,
  type CoordinatorDiscoveryRecord,
  type DiscoveryRead,
  type DiscoveryRuntime,
} from '#src/infra/backend-discovery.js';
import type { BuildFlavor } from '#src/infra/build-flavor.js';
import { observeProcessLiveness, type ProcessLiveness } from '#src/infra/node-process.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { createIpcClient } from '#src/transport/ipc/client.js';
import type { SpawnedCoordinator } from '#tests/integration/coordinator/helpers.js';
import { waitForCondition } from '#tests/support/wait-for-condition.js';

declare const temporaryHomeBrand: unique symbol;

/** Only paths registered with a lifecycle owner may be wired into an e2e process as HOME. */
export type TemporaryHome = string & { readonly [temporaryHomeBrand]: true };

type OwnedHome = Readonly<{
  path: TemporaryHome;
  discoveryRuntime: DiscoveryRuntime;
  coordinator?: Readonly<{
    handle: SpawnedCoordinator;
    stop: (handle: SpawnedCoordinator) => Promise<void>;
  }>;
}>;

type ShutdownDisposition = ProcessLiveness | 'no-record' | Extract<DiscoveryRead, { kind: 'undecodable' }>;

/** Cleanup may remove a HOME only after every process obligation has decisive absence evidence. */
export type TemporaryHomeOwner = Readonly<{
  create(prefix: string, flavor: BuildFlavor): TemporaryHome;
  registerCoordinator(
    path: TemporaryHome,
    coordinator: SpawnedCoordinator,
    stop: (handle: SpawnedCoordinator) => Promise<void>,
  ): void;
  environment(path: TemporaryHome): Readonly<{ HOME: TemporaryHome }>;
  discoveryRuntime(path: TemporaryHome): DiscoveryRuntime;
  readDiscovery(path: TemporaryHome): DiscoveryRead;
  withHome<T>(path: TemporaryHome, action: () => Promise<T> | T): Promise<T>;
  cleanup(): Promise<void>;
}>;

function signalObservedProcess(pid: number, signal: NodeJS.Signals): ProcessLiveness {
  const liveness = observeProcessLiveness(pid);
  if (liveness !== 'alive') return liveness;

  try {
    process.kill(pid, signal);
    return 'alive';
  } catch (error: unknown) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    if (code === 'ESRCH') return 'absent';
    throw error;
  }
}

async function waitForObservedAbsence(pid: number, timeoutMs: number): Promise<ProcessLiveness> {
  try {
    await waitForCondition(() => observeProcessLiveness(pid) === 'absent', timeoutMs);
    return 'absent';
  } catch {
    return observeProcessLiveness(pid);
  }
}

async function shutdownDiscoveredCoordinator(record: CoordinatorDiscoveryRecord): Promise<ProcessLiveness> {
  const initialLiveness = observeProcessLiveness(record.pid);
  if (initialLiveness !== 'alive') return initialLiveness;

  try {
    await createIpcClient(record.socketPath, undefined, { kind: 'boot', token: record.bootToken }).shutdown({
      timeoutMs: 5_000,
    });
  } catch {
    const termDisposition = signalObservedProcess(record.pid, 'SIGTERM');
    if (termDisposition !== 'alive') return termDisposition;
  }

  const gracefulDisposition = await waitForObservedAbsence(record.pid, 10_000);
  if (gracefulDisposition !== 'alive') return gracefulDisposition;

  const killDisposition = signalObservedProcess(record.pid, 'SIGKILL');
  if (killDisposition !== 'alive') return killDisposition;
  return waitForObservedAbsence(record.pid, 2_000);
}

async function shutdownRegisteredCoordinator(
  coordinator: SpawnedCoordinator,
  stop: (handle: SpawnedCoordinator) => Promise<void>,
): Promise<ProcessLiveness> {
  await stop(coordinator);
  return coordinator.child.exitCode !== null || coordinator.child.signalCode !== null ? 'absent' : 'unknown';
}

async function shutdownBackend(home: OwnedHome, discovery: DiscoveryRead): Promise<ShutdownDisposition> {
  if (home.coordinator !== undefined) {
    const handleDisposition = await shutdownRegisteredCoordinator(home.coordinator.handle, home.coordinator.stop);
    if (handleDisposition !== 'absent') return handleDisposition;
    if (discovery.kind === 'undecodable') return discovery;
    if (discovery.kind === 'missing') return 'absent';
    if (discovery.record.pid === home.coordinator.handle.child.pid) return 'absent';
  }

  if (discovery.kind === 'missing') return 'no-record';
  if (discovery.kind === 'undecodable') return discovery;
  return shutdownDiscoveredCoordinator(discovery.record);
}

function formatError(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

function report(message: string): void {
  console.error(`[temporary-home teardown] ${message}`);
}

async function cleanupHome(home: OwnedHome): Promise<void> {
  let disposition: ShutdownDisposition;
  try {
    const discovery = readDiscoveryRecordDisposition(home.discoveryRuntime);
    disposition = await shutdownBackend(home, discovery);
  } catch (error: unknown) {
    report(`preserved ${home.path} because backend shutdown failed: ${formatError(error)}`);
    return;
  }

  if (typeof disposition !== 'string') {
    report(`preserved ${home.path} because the coordinator discovery record was undecodable (${disposition.reason})`);
    return;
  }
  if (disposition === 'alive' || disposition === 'unknown') {
    report(`preserved ${home.path} because coordinator absence was not observed (${disposition})`);
    return;
  }

  try {
    rmSync(home.path, { recursive: true, force: true });
  } catch (error: unknown) {
    report(`could not remove ${home.path}: ${formatError(error)}`);
  }
}

/** Cleanup is scoped to paths created by this owner instance. */
export function createTemporaryHomeOwner(): TemporaryHomeOwner {
  const homes: OwnedHome[] = [];

  function ownedHome(path: TemporaryHome): OwnedHome {
    const home = homes.find((candidate) => candidate.path === path);
    if (home === undefined) throw new Error(`Temporary HOME is not owned: ${path}`);
    return home;
  }

  return {
    create(prefix: string, flavor: BuildFlavor): TemporaryHome {
      const path = mkdtempSync(join(tmpdir(), prefix)) as TemporaryHome;
      const runtime = createRealRuntime(flavor, { baseDir: join(path, '.coral') });
      homes.push({
        path,
        discoveryRuntime: { storage: runtime.storage, env: runtime.env, paths: runtime.paths },
      });
      return path;
    },

    registerCoordinator(
      path: TemporaryHome,
      coordinator: SpawnedCoordinator,
      stop: (handle: SpawnedCoordinator) => Promise<void>,
    ): void {
      const home = ownedHome(path);
      const index = homes.indexOf(home);
      homes[index] = { ...home, coordinator: { handle: coordinator, stop } };
    },

    environment(path: TemporaryHome): Readonly<{ HOME: TemporaryHome }> {
      ownedHome(path);
      return { HOME: path };
    },

    discoveryRuntime(path: TemporaryHome): DiscoveryRuntime {
      return ownedHome(path).discoveryRuntime;
    },

    readDiscovery(path: TemporaryHome): DiscoveryRead {
      return readDiscoveryRecordDisposition(ownedHome(path).discoveryRuntime);
    },

    async withHome<T>(path: TemporaryHome, action: () => Promise<T> | T): Promise<T> {
      ownedHome(path);
      const previousHome = process.env.HOME;
      process.env.HOME = path;
      try {
        return await action();
      } finally {
        if (previousHome === undefined) {
          delete process.env.HOME;
        } else {
          process.env.HOME = previousHome;
        }
      }
    },

    async cleanup(): Promise<void> {
      const ownedHomes = homes.splice(0).reverse();
      const results = await Promise.allSettled(ownedHomes.map(cleanupHome));
      for (const [index, result] of results.entries()) {
        if (result.status === 'rejected') {
          report(`cleanup failed for ${ownedHomes[index]?.path ?? 'unknown HOME'}: ${formatError(result.reason)}`);
        }
      }
    },
  };
}
