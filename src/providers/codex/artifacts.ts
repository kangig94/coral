import { join } from 'node:path';

import { discardRecordedArtifacts, managed } from '../capability.js';
import type { ProviderArtifactHandleInput, ProviderRuntime } from '../contract.js';
import type { StoragePort } from '../../infra/port-types.js';
import type { ProviderArtifactIdentity } from '../artifact-identity.js';
import type { CodexCredentialSource, CodexExecutionContext } from './execution-context.js';

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
  runtime: Pick<ProviderRuntime<CodexExecutionContext>, 'providerContext' | 'storage'>,
): ProviderArtifactLocatorResult | null {
  return locateCodexRolloutArtifact({
    threadId,
    sessionsRoot: join(runtime.providerContext.source.home, 'sessions'),
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

export const codexArtifactCapability = managed<CodexCredentialSource>({
  discardArtifacts: ({ handles, runtime }) => discardRecordedArtifacts(handles, runtime),
  locateArtifact: ({ conversationRef, source, runtime }) => {
    const result = locateCodexRolloutArtifact({
      threadId: conversationRef,
      sessionsRoot: join(source.home, 'sessions'),
      storage: runtime.storage,
    });
    return result.kind === 'match' ? result.artifact.handle : null;
  },
});
