import { posix, win32 } from 'node:path';

import { readDiscoveryRecordDisposition } from '../infra/backend-discovery.js';
import { formatError } from '../infra/error-format.js';
import { v0109CoordinatorSocketGuardSetForRunDir } from '../infra/path/index.js';
import { documentedCoralSetupError } from '../runtime/errors.js';
import type { Runtime } from '../runtime/ports.js';
import type { PublishedIpcSocketAddress } from '../transport/ipc/server.js';

type CoordinatorSocketAddressBinding =
  | Readonly<{ kind: 'held'; release(): Promise<void> }>
  | Readonly<{ kind: 'incumbent'; socketPath: string }>;

export interface CoordinatorSocketAddressClaim {
  readonly initialIncumbentSocketPath: string;
  acquire(
    bindAtomicallyWithPrimary: (
      additionalSocketPaths: readonly string[],
      publishedSocketAddresses: readonly PublishedIpcSocketAddress[],
    ) => Promise<CoordinatorSocketAddressBinding>,
  ): Promise<CoordinatorSocketAddressBinding>;
}

type CoordinatorSocketAddressRuntime = Pick<Runtime, 'env' | 'flavor' | 'paths' | 'storage'>;

type PublishedCoordinatorSocketRead =
  | Readonly<{ kind: 'missing' }>
  | Readonly<{ kind: 'published'; socketPath: string }>;

export function createCoordinatorSocketAddressClaim(
  runtime: CoordinatorSocketAddressRuntime,
  subject: string,
): CoordinatorSocketAddressClaim {
  const primarySocketPath = runtime.paths.coral.coordinator.socketPath;
  const platform = runtime.env.platform();
  const v0109SocketGuards = v0109CoordinatorSocketGuardSetForRunDir(
    runtime.paths.coral.coordinator.runDir,
    runtime.flavor,
    {
      platform,
      configuredTempDirectory: runtime.env.get('TMPDIR'),
      systemTempDirectory: runtime.env.tmpdir(),
    },
  );
  if (v0109SocketGuards.kind === 'address-unenumerable') {
    throw new Error(
      `Cannot enumerate the shipped v0.10.9 coordinator socket from ${v0109SocketGuards.source}=${JSON.stringify(v0109SocketGuards.value)}.`,
    );
  }

  const computedSocketPaths = new Set(v0109SocketGuards.paths);
  const publishedSocketAddresses = new Map<string, PublishedIpcSocketAddress>();
  const asPublishedSocketAddress = (socketPath: string): PublishedIpcSocketAddress => {
    const path = platform === 'win32' ? win32 : posix;
    const publishedParent = path.dirname(socketPath);
    const publishedGuards = v0109CoordinatorSocketGuardSetForRunDir(
      runtime.paths.coral.coordinator.runDir,
      runtime.flavor,
      {
        platform,
        configuredTempDirectory: publishedParent,
        systemTempDirectory: publishedParent,
      },
    );
    if (publishedGuards.kind !== 'guarded-addresses' || !publishedGuards.paths.includes(socketPath)) {
      throw documentedCoralSetupError({
        code: 'coordinator_record_unreadable',
        subject,
        path: runtime.paths.coral.coordinator.infoFile,
        detail: `published socket path is outside Coral's coordinator namespace: ${JSON.stringify(socketPath)}`,
      });
    }
    return { socketPath, ownedSocketName: path.basename(socketPath) };
  };
  const rememberPublishedSocket = (): PublishedCoordinatorSocketRead => {
    const observation = readPublishedCoordinatorSocket(runtime, subject, platform);
    if (
      observation.kind === 'published' &&
      observation.socketPath !== primarySocketPath &&
      !computedSocketPaths.has(observation.socketPath)
    ) {
      publishedSocketAddresses.set(observation.socketPath, asPublishedSocketAddress(observation.socketPath));
    }
    return observation;
  };
  const initial = rememberPublishedSocket();
  let acquireStarted = false;
  const additionalSocketPaths = (): readonly string[] =>
    [...computedSocketPaths].filter((socketPath) => socketPath !== primarySocketPath);
  const additionalPublishedSocketAddresses = (): readonly PublishedIpcSocketAddress[] => [
    ...publishedSocketAddresses.values(),
  ];

  return {
    initialIncumbentSocketPath: initial.kind === 'published' ? initial.socketPath : primarySocketPath,
    acquire: async (bindAtomicallyWithPrimary) => {
      if (acquireStarted) rememberPublishedSocket();
      acquireStarted = true;
      while (true) {
        const attemptedSocketPaths = additionalSocketPaths();
        const attemptedPublishedSocketAddresses = additionalPublishedSocketAddresses();
        const attempted = new Set([
          ...attemptedSocketPaths,
          ...attemptedPublishedSocketAddresses.map((address) => address.socketPath),
        ]);
        const binding = await bindAtomicallyWithPrimary(attemptedSocketPaths, attemptedPublishedSocketAddresses);
        if (binding.kind === 'incumbent') return binding;

        try {
          rememberPublishedSocket();
        } catch (error: unknown) {
          await binding.release();
          throw error;
        }
        if (additionalPublishedSocketAddresses().some((address) => !attempted.has(address.socketPath))) {
          await binding.release();
          continue;
        }
        return binding;
      }
    },
  };
}

function readPublishedCoordinatorSocket(
  runtime: CoordinatorSocketAddressRuntime,
  subject: string,
  platform: string,
): PublishedCoordinatorSocketRead {
  let read: ReturnType<typeof readDiscoveryRecordDisposition>;
  try {
    read = readDiscoveryRecordDisposition({ storage: runtime.storage, env: runtime.env, paths: runtime.paths });
  } catch (error: unknown) {
    throw documentedCoralSetupError({
      code: 'coordinator_record_unreadable',
      subject,
      path: runtime.paths.coral.coordinator.infoFile,
      detail: formatError(error),
    });
  }
  switch (read.kind) {
    case 'record':
      if (!(platform === 'win32' ? win32 : posix).isAbsolute(read.record.socketPath)) {
        throw documentedCoralSetupError({
          code: 'coordinator_record_unreadable',
          subject,
          path: runtime.paths.coral.coordinator.infoFile,
          detail: `published socket path is not absolute: ${JSON.stringify(read.record.socketPath)}`,
        });
      }
      return { kind: 'published', socketPath: read.record.socketPath };
    case 'missing':
      return { kind: 'missing' };
    case 'undecodable':
      throw documentedCoralSetupError({
        code: 'coordinator_record_unreadable',
        subject,
        path: runtime.paths.coral.coordinator.infoFile,
        detail: read.reason,
      });
  }
}
