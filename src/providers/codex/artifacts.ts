import { join } from 'node:path';

import { discardRecordedArtifacts, managed, reconcileRecordedArtifactDiscard } from '../capability.js';
import type {
  ArtifactCleanupRuntime,
  ProviderArtifactHandleInput,
  ProviderResidueDiscardOutcome,
  ProviderRuntime,
} from '../contract.js';
import { errorMessage } from '../../infra/error-format.js';
import { isRecord } from '../../infra/json.js';
import type { StoragePort } from '../../infra/port-types.js';
import type { ProviderArtifactIdentity } from '../artifact-identity.js';
import type { CodexProviderAccess, CodexExecutionPlan } from './execution-plan.js';

const CODEX_ROLLOUT_SCAN_DEPTH = 4;

type CodexArtifactLocatorStorage = Pick<StoragePort, 'existsSync' | 'readdirSync'>;

type CodexArtifactIndex = {
  readonly rolloutFiles: readonly { readonly name: string; readonly path: string }[];
};

export type ProviderArtifactLocatorResult =
  | { readonly kind: 'match'; readonly artifact: ProviderArtifactHandleInput }
  | { readonly kind: 'no_match'; readonly diagnostic: string }
  | { readonly kind: 'ambiguous'; readonly diagnostic: string; readonly matches: readonly string[] };

const codexArtifactIndexes = new WeakMap<object, Map<string, CodexArtifactIndex>>();

function codexRolloutArtifactIdentity(threadId: string): ProviderArtifactIdentity {
  return { kind: 'codex-rollout', threadId };
}

export function locateCodexRolloutArtifact(options: {
  readonly threadId: string;
  readonly sessionsRoot: string;
  readonly storage: CodexArtifactLocatorStorage;
}): ProviderArtifactLocatorResult {
  let index = readCodexArtifactIndex(options.storage, options.sessionsRoot);
  let matches = collectCodexRolloutMatches(index, options.threadId);
  if (matches.length === 0) {
    index = refreshCodexArtifactIndex(options.storage, options.sessionsRoot);
    matches = collectCodexRolloutMatches(index, options.threadId);
  }

  if (matches.length === 0) {
    return {
      kind: 'no_match',
      diagnostic: `No rollout JSONL found matching thread ${options.threadId} under ${options.sessionsRoot}.`,
    };
  }
  if (matches.length > 1) {
    return {
      kind: 'ambiguous',
      diagnostic: `${matches.length} rollout JSONL files matched thread ${options.threadId} under ${options.sessionsRoot}; cannot choose one.`,
      matches,
    };
  }
  const [handle] = matches;
  return {
    kind: 'match',
    artifact: {
      handle,
      identity: codexRolloutArtifactIdentity(options.threadId),
    },
  };
}

export function locateCodexRolloutArtifactFromRuntime(
  threadId: string,
  runtime: Pick<ProviderRuntime<CodexExecutionPlan>, 'executionPlan' | 'storage'>,
): ProviderArtifactLocatorResult | null {
  return locateCodexRolloutArtifact({
    threadId,
    sessionsRoot: join(runtime.executionPlan.host.access.home, 'sessions'),
    storage: runtime.storage,
  });
}

function readCodexArtifactIndex(storage: CodexArtifactLocatorStorage, root: string): CodexArtifactIndex {
  return artifactIndexCacheForStorage(storage).get(root) ?? refreshCodexArtifactIndex(storage, root);
}

function refreshCodexArtifactIndex(storage: CodexArtifactLocatorStorage, root: string): CodexArtifactIndex {
  const rolloutFiles: Array<{ name: string; path: string }> = [];
  if (safeExists(storage, root)) {
    const visit = (dir: string, depth: number): void => {
      const entries = safeReadDir(storage, dir);
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isFile()) {
          if (isRolloutFile(entry.name)) {
            rolloutFiles.push({ name: entry.name, path: fullPath });
          }
          continue;
        }
        if (entry.isDirectory() && depth < CODEX_ROLLOUT_SCAN_DEPTH) {
          visit(fullPath, depth + 1);
        }
      }
    };
    visit(root, 0);
  }

  rolloutFiles.sort((left, right) => left.path.localeCompare(right.path));
  const index = { rolloutFiles };
  artifactIndexCacheForStorage(storage).set(root, index);
  return index;
}

function artifactIndexCacheForStorage(storage: CodexArtifactLocatorStorage): Map<string, CodexArtifactIndex> {
  const key = storage as object;
  const existing = codexArtifactIndexes.get(key);
  if (existing !== undefined) {
    return existing;
  }
  const next = new Map<string, CodexArtifactIndex>();
  codexArtifactIndexes.set(key, next);
  return next;
}

function collectCodexRolloutMatches(index: CodexArtifactIndex, threadId: string): readonly string[] {
  const matches: string[] = [];
  for (const file of index.rolloutFiles) {
    if (isCodexRolloutFile(file.name, threadId)) {
      matches.push(file.path);
    }
  }
  return matches;
}

function isRolloutFile(name: string): boolean {
  return name.startsWith('rollout-') && name.endsWith('.jsonl');
}

function isCodexRolloutFile(name: string, threadId: string): boolean {
  return name.startsWith('rollout-') && name.endsWith(`-${threadId}.jsonl`);
}

function safeExists(storage: CodexArtifactLocatorStorage, path: string): boolean {
  try {
    return storage.existsSync(path);
  } catch {
    return false;
  }
}

function safeReadDir(storage: CodexArtifactLocatorStorage, path: string) {
  try {
    return storage.readdirSync(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

// A rollout's first record carries the full base instructions, tens of kilobytes; one that has not
// ended within this bound is not a header this reader understands.
const CODEX_ROLLOUT_HEADER_LIMIT_BYTES = 1024 * 1024;
const CODEX_ROLLOUT_HEADER_CHUNK_BYTES = 64 * 1024;
// A fork is written no earlier than the session it descends from began, and a rollout's mtime is no earlier
// than its creation, so anything older cannot be a descendant. The slack absorbs skew between the clock that
// stamped the session and the filesystem's.
const ROLLOUT_MTIME_SLACK_MS = 24 * 60 * 60 * 1000;
const CODEX_THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODEX_ROLLOUT_THREAD_ID = /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

type CodexRolloutParent =
  | { readonly kind: 'fork'; readonly threadId: string; readonly parent: string }
  | { readonly kind: 'root'; readonly threadId: string }
  | { readonly kind: 'unreadable' };

type CodexRollout = { readonly threadId: string; readonly path: string };

// Keyed by path. A `session_meta` record is written once and never rewritten, so a parsed answer stays
// true; an unreadable one is not cached, because a header still being written reads that way.
const codexRolloutParents = new WeakMap<object, Map<string, Exclude<CodexRolloutParent, { kind: 'unreadable' }>>>();

function parseCodexRolloutParent(line: string): CodexRolloutParent {
  let record: unknown;
  try {
    record = JSON.parse(line);
  } catch {
    return { kind: 'unreadable' };
  }
  if (!isRecord(record) || record.type !== 'session_meta' || !isRecord(record.payload)) return { kind: 'unreadable' };
  const threadId = record.payload.id;
  if (typeof threadId !== 'string' || !CODEX_THREAD_ID.test(threadId)) return { kind: 'unreadable' };
  const source = record.payload.source;
  const subagent = isRecord(source) ? source.subagent : undefined;
  const spawn = isRecord(subagent) ? subagent.thread_spawn : undefined;
  const parent = isRecord(spawn) ? spawn.parent_thread_id : undefined;
  return typeof parent === 'string' && CODEX_THREAD_ID.test(parent)
    ? { kind: 'fork', threadId, parent }
    : { kind: 'root', threadId };
}

function readCodexRolloutParent(storage: StoragePort, path: string): CodexRolloutParent {
  let fd: number;
  try {
    fd = storage.openSync(path, 'r');
  } catch {
    return { kind: 'unreadable' };
  }
  try {
    const chunks: Buffer[] = [];
    const buffer = Buffer.alloc(CODEX_ROLLOUT_HEADER_CHUNK_BYTES);
    let position = 0;
    while (position < CODEX_ROLLOUT_HEADER_LIMIT_BYTES) {
      const read = storage.readSync(fd, buffer, 0, buffer.length, position);
      if (read === 0) return { kind: 'unreadable' };
      const chunk = buffer.subarray(0, read);
      const newline = chunk.indexOf(0x0a);
      if (newline >= 0) {
        chunks.push(Buffer.from(chunk.subarray(0, newline)));
        return parseCodexRolloutParent(Buffer.concat(chunks).toString('utf8'));
      }
      chunks.push(Buffer.from(chunk));
      position += read;
    }
    return { kind: 'unreadable' };
  } catch {
    return { kind: 'unreadable' };
  } finally {
    try {
      storage.closeSync(fd);
    } catch {
      // A close failure cannot change what was read.
    }
  }
}

function codexRolloutParent(storage: StoragePort, path: string): CodexRolloutParent {
  let cache = codexRolloutParents.get(storage);
  if (cache === undefined) {
    cache = new Map();
    codexRolloutParents.set(storage, cache);
  }
  const cached = cache.get(path);
  if (cached !== undefined) return cached;
  const parent = readCodexRolloutParent(storage, path);
  if (parent.kind !== 'unreadable') cache.set(path, parent);
  return parent;
}

function codexForksByParent(storage: StoragePort, sessionsRoot: string, since: number): Map<string, CodexRollout[]> {
  const forksByParent = new Map<string, CodexRollout[]>();
  for (const rollout of refreshCodexArtifactIndex(storage, sessionsRoot).rolloutFiles) {
    const threadId = CODEX_ROLLOUT_THREAD_ID.exec(rollout.name)?.[1];
    if (threadId === undefined) continue;
    let modifiedAt: number;
    try {
      modifiedAt = storage.statSync(rollout.path).mtimeMs;
    } catch {
      continue;
    }
    if (modifiedAt < since - ROLLOUT_MTIME_SLACK_MS) continue;
    const parent = codexRolloutParent(storage, rollout.path);
    // A header naming another thread than its filename is not evidence about either.
    if (parent.kind !== 'fork' || parent.threadId.toLowerCase() !== threadId.toLowerCase()) continue;
    const siblings = forksByParent.get(parent.parent) ?? [];
    siblings.push({ threadId, path: rollout.path });
    forksByParent.set(parent.parent, siblings);
  }
  return forksByParent;
}

/**
 * Discards every rollout that descends from `rootThreadId` through `parent_thread_id`, deepest first.
 *
 * A fork is found through its parent's id, so a fork deleted before its own child would leave that child
 * unreachable on the next call. Deleting leaves first, and keeping any fork one of whose descendants was
 * kept, means an interrupted or partial discard always leaves a tree the next call can still walk.
 */
export function discardCodexRolloutResidue(options: {
  readonly rootThreadId: string;
  readonly sessionsRoot: string;
  readonly since: number;
  readonly runtime: ArtifactCleanupRuntime;
}): ProviderResidueDiscardOutcome {
  if (!CODEX_THREAD_ID.test(options.rootThreadId) || !Number.isFinite(options.since)) {
    return { discarded: [], retained: [] };
  }
  const storage = options.runtime.storage;
  const forksByParent = codexForksByParent(storage, options.sessionsRoot, options.since);

  const descendants: Array<CodexRollout & { readonly depth: number }> = [];
  const visited = new Set<string>();
  const queue: Array<{ readonly threadId: string; readonly depth: number }> = [
    { threadId: options.rootThreadId, depth: 0 },
  ];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    for (const fork of forksByParent.get(next.threadId) ?? []) {
      if (fork.threadId === options.rootThreadId || visited.has(fork.path)) continue;
      visited.add(fork.path);
      descendants.push({ ...fork, depth: next.depth + 1 });
      queue.push({ threadId: fork.threadId, depth: next.depth + 1 });
    }
  }
  descendants.sort((left, right) => right.depth - left.depth);

  const discarded: string[] = [];
  const retained: Array<{ path: string; reason: string }> = [];
  const retainedThreads = new Set<string>();
  for (const fork of descendants) {
    if ((forksByParent.get(fork.threadId) ?? []).some((child) => retainedThreads.has(child.threadId))) {
      retainedThreads.add(fork.threadId);
      retained.push({ path: fork.path, reason: 'a descendant fork was retained' });
      continue;
    }
    try {
      storage.unlinkSync(fork.path);
      discarded.push(fork.path);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') continue;
      retainedThreads.add(fork.threadId);
      retained.push({ path: fork.path, reason: errorMessage(error) });
    }
  }
  return { discarded, retained };
}

export const codexArtifactCapability = managed<CodexProviderAccess>({
  discardArtifacts: ({ handles, runtime }) => discardRecordedArtifacts(handles, runtime),
  reconcileDiscard: ({ handles, runtime }) => Promise.resolve(reconcileRecordedArtifactDiscard(handles, runtime)),
  locateArtifact: ({ conversationRef, access, runtime }) => {
    const result = locateCodexRolloutArtifact({
      threadId: conversationRef,
      sessionsRoot: join(access.home, 'sessions'),
      storage: runtime.storage,
    });
    return result.kind === 'match' ? result.artifact.handle : null;
  },
  discardResidue: ({ conversationRef, since, access, runtime }) =>
    Promise.resolve(
      discardCodexRolloutResidue({
        rootThreadId: conversationRef,
        sessionsRoot: join(access.home, 'sessions'),
        since,
        runtime,
      }),
    ),
});
