import { existsSync, readFileSync, readdirSync } from 'node:fs';

import type { DiscussDomainEvent, PersistedDiscussSnapshot } from '../../discuss/events.js';
import {
  readDiscussDiscoveryForSourceWithStorage,
  readDiscussEventLogWithStorage,
  readDiscussSnapshotWithStorage,
  readDiscussSummaryIndexForSourceWithStorage,
  resolveDiscussSessionDirForSourceWithStorage,
} from '../../discuss/shell/discuss-sources-catalog.js';
import {
  discussBaseDirForSource,
  discussDiscoveryPathForSource,
  discussEventLogPath,
  discussSessionDirForSource,
  discussSourcesPath,
  discussStatePath,
  discussSummaryIndexPathForSource,
  resolveProjectSource,
} from '../../infra/paths.js';
import type { DiscussPathResolver, StoragePort } from '../../runtime/ports.js';
import type {
  DiscussDiscoveryData,
  DiscussSummaryIndexData,
} from '../../discuss/persistence-types.js';

export type DiscussSnapshotRow = PersistedDiscussSnapshot;
export type DiscussEventLogEntry = DiscussDomainEvent;
export type DiscussReadRef =
  | string
  | {
      source: string;
      sessionId: string;
    };

const nodeDiscussStorage: Pick<StoragePort, 'existsSync' | 'readFileSync' | 'readdirSync'> = {
  existsSync: (filePath) => existsSync(filePath),
  readFileSync: (filePath, encoding) => readFileSync(filePath, encoding),
  readdirSync: (dirPath, options) => readdirSync(dirPath, options),
};

const nodeDiscussPaths: Pick<
  DiscussPathResolver,
  | 'projectSource'
  | 'discussSourcesPath'
  | 'discussBaseDirForSource'
  | 'discussDiscoveryPathForSource'
  | 'discussSummaryIndexPathForSource'
  | 'discussSessionDirForSource'
  | 'discussStatePath'
  | 'discussEventLogPath'
> = {
  projectSource: resolveProjectSource,
  discussSourcesPath,
  discussBaseDirForSource,
  discussDiscoveryPathForSource,
  discussSummaryIndexPathForSource,
  discussSessionDirForSource,
  discussStatePath,
  discussEventLogPath,
};

function resolveDiscussFilePath(
  ref: DiscussReadRef,
  kind: 'snapshot' | 'event-log',
): string | null {
  if (typeof ref === 'string') {
    return ref;
  }

  const sessionDir = resolveDiscussSessionDirForSourceWithStorage(
    nodeDiscussStorage,
    nodeDiscussPaths,
    ref.source,
    ref.sessionId,
  );

  if (sessionDir === null) {
    return null;
  }

  return kind === 'snapshot' ? discussStatePath(sessionDir) : discussEventLogPath(sessionDir);
}

export function readDiscussSnapshot(
  ref: DiscussReadRef,
): DiscussSnapshotRow | null {
  const statePath = resolveDiscussFilePath(ref, 'snapshot');
  return statePath === null ? null : readDiscussSnapshotWithStorage(nodeDiscussStorage, statePath);
}

export function readDiscussEventLog(
  ref: DiscussReadRef,
): DiscussEventLogEntry[] {
  const logPath = resolveDiscussFilePath(ref, 'event-log');
  return logPath === null ? [] : readDiscussEventLogWithStorage(nodeDiscussStorage, logPath);
}

export function readDiscussDiscovery(
  source: string,
): DiscussDiscoveryData | null {
  return readDiscussDiscoveryForSourceWithStorage(nodeDiscussStorage, nodeDiscussPaths, source);
}

export function readDiscussSummaryIndex(
  source: string,
): DiscussSummaryIndexData | null {
  return readDiscussSummaryIndexForSourceWithStorage(nodeDiscussStorage, nodeDiscussPaths, source);
}
