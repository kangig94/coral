import { join } from 'node:path';

import { discardRecordedArtifacts, managed } from '../capability.js';
import type { ProviderArtifactHandleInput, ProviderRuntime } from '../contract.js';
import type { StoragePort } from '../../infra/port-types.js';
import type { ProviderArtifactIdentity } from '../artifact-identity.js';
import type { ClaudeProviderAccess, ClaudeExecutionPlan } from './execution-plan.js';

type ClaudeArtifactLocatorStorage = Pick<StoragePort, 'existsSync' | 'readdirSync'>;
type ClaudeArtifactCleanupStorage = ClaudeArtifactLocatorStorage & Pick<StoragePort, 'unlinkSync'>;

type ClaudeArtifactIndex = {
  readonly matchesByConversationRef: ReadonlyMap<string, readonly string[]>;
};

export type ClaudeArtifactLocatorResult =
  | { readonly kind: 'match'; readonly artifact: ProviderArtifactHandleInput }
  | { readonly kind: 'no_match'; readonly diagnostic: string }
  | { readonly kind: 'ambiguous'; readonly diagnostic: string; readonly matches: readonly string[] };

export type ClaudeJsonlCleanupResult = {
  readonly deleted: readonly string[];
  readonly missing: boolean;
  readonly errors: readonly { readonly handle: string; readonly message: string }[];
};

const claudeArtifactIndexes = new WeakMap<object, Map<string, ClaudeArtifactIndex>>();

function claudeJsonlArtifactIdentity(conversationRef: string): ProviderArtifactIdentity {
  return { kind: 'claude-jsonl', conversationRef };
}

export function locateClaudeJsonlArtifact(options: {
  readonly conversationRef: string;
  readonly projectsRoot: string;
  readonly storage: ClaudeArtifactLocatorStorage;
}): ClaudeArtifactLocatorResult {
  let index = readClaudeArtifactIndex(options.storage, options.projectsRoot);
  let matches = index.matchesByConversationRef.get(options.conversationRef) ?? [];
  if (matches.length === 0) {
    index = refreshClaudeArtifactIndex(options.storage, options.projectsRoot);
    matches = index.matchesByConversationRef.get(options.conversationRef) ?? [];
  }

  if (matches.length === 0) {
    return {
      kind: 'no_match',
      diagnostic: `No JSONL found matching conversation ${options.conversationRef} under ${options.projectsRoot}.`,
    };
  }
  if (matches.length > 1) {
    return {
      kind: 'ambiguous',
      diagnostic: `${matches.length} JSONL files matched conversation ${options.conversationRef} under ${options.projectsRoot}; cannot choose one.`,
      matches,
    };
  }
  const [handle] = matches;
  return {
    kind: 'match',
    artifact: {
      handle,
      identity: claudeJsonlArtifactIdentity(options.conversationRef),
    },
  };
}

export function locateClaudeJsonlArtifactFromRuntime(
  conversationRef: string,
  runtime: Pick<ProviderRuntime<ClaudeExecutionPlan>, 'executionPlan' | 'storage'>,
): ClaudeArtifactLocatorResult | null {
  return locateClaudeJsonlArtifact({
    conversationRef,
    projectsRoot: runtime.executionPlan.session.projectsRoot,
    storage: runtime.storage,
  });
}

export function deleteClaudeJsonlArtifactsForConversation(options: {
  readonly conversationRef: string;
  readonly projectsRoot: string;
  readonly storage: ClaudeArtifactCleanupStorage;
}): ClaudeJsonlCleanupResult {
  const located = locateClaudeJsonlArtifact(options);
  const handles =
    located.kind === 'match'
      ? [located.artifact.handle]
      : located.kind === 'ambiguous'
        ? [...new Set(located.matches)]
        : [];

  const deleted: string[] = [];
  const errors: Array<{ handle: string; message: string }> = [];
  for (const handle of handles) {
    try {
      options.storage.unlinkSync(handle);
      deleted.push(handle);
    } catch (error) {
      errors.push({
        handle,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (handles.length > 0) {
    invalidateClaudeArtifactIndex(options.storage, options.projectsRoot);
  }

  return {
    deleted,
    missing: located.kind === 'no_match',
    errors,
  };
}

function readClaudeArtifactIndex(storage: ClaudeArtifactLocatorStorage, projectsRoot: string): ClaudeArtifactIndex {
  return artifactIndexCacheForStorage(storage).get(projectsRoot) ?? refreshClaudeArtifactIndex(storage, projectsRoot);
}

function refreshClaudeArtifactIndex(storage: ClaudeArtifactLocatorStorage, projectsRoot: string): ClaudeArtifactIndex {
  const matchesByConversationRef = new Map<string, string[]>();
  if (safeExists(storage, projectsRoot)) {
    for (const projectEntry of safeReadDir(storage, projectsRoot)) {
      if (!projectEntry.isDirectory()) {
        continue;
      }

      const projectDir = join(projectsRoot, projectEntry.name);
      for (const artifactEntry of safeReadDir(storage, projectDir)) {
        if (!artifactEntry.isFile() || !artifactEntry.name.endsWith('.jsonl')) {
          continue;
        }
        const conversationRef = artifactEntry.name.slice(0, -'.jsonl'.length);
        const matches = matchesByConversationRef.get(conversationRef) ?? [];
        matches.push(join(projectDir, artifactEntry.name));
        matchesByConversationRef.set(conversationRef, matches);
      }
    }
  }

  for (const matches of matchesByConversationRef.values()) {
    matches.sort();
  }
  const index = { matchesByConversationRef };
  artifactIndexCacheForStorage(storage).set(projectsRoot, index);
  return index;
}

function artifactIndexCacheForStorage(storage: ClaudeArtifactLocatorStorage): Map<string, ClaudeArtifactIndex> {
  const key = storage as object;
  const existing = claudeArtifactIndexes.get(key);
  if (existing !== undefined) {
    return existing;
  }
  const next = new Map<string, ClaudeArtifactIndex>();
  claudeArtifactIndexes.set(key, next);
  return next;
}

function invalidateClaudeArtifactIndex(storage: ClaudeArtifactLocatorStorage, projectsRoot: string): void {
  artifactIndexCacheForStorage(storage).delete(projectsRoot);
}

function safeExists(storage: ClaudeArtifactLocatorStorage, path: string): boolean {
  try {
    return storage.existsSync(path);
  } catch {
    return false;
  }
}

function safeReadDir(storage: ClaudeArtifactLocatorStorage, path: string) {
  try {
    return storage.readdirSync(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

export const claudeArtifactCapability = managed<ClaudeProviderAccess>({
  discardArtifacts: ({ handles, runtime }) => discardRecordedArtifacts(handles, runtime),
  locateArtifact: ({ conversationRef, access, runtime }) => {
    const result = locateClaudeJsonlArtifact({
      conversationRef,
      projectsRoot: access.projectsRoot,
      storage: runtime.storage,
    });
    return result.kind === 'match' ? result.artifact.handle : null;
  },
});
