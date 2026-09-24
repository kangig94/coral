import { join, sep } from 'node:path';

import { discardRecordedArtifacts, managed, reconcileRecordedArtifactDiscard } from '../capability.js';
import type {
  ArtifactCleanupRuntime,
  ProviderArtifactHandleInput,
  ProviderResidueDiscardOutcome,
  ProviderRuntime,
} from '../contract.js';
import { errorMessage } from '../../infra/error-format.js';
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

// A conversation id is a single path segment; anything else could name a directory it does not own.
const CLAUDE_CONVERSATION_REF = /^[0-9A-Za-z][0-9A-Za-z-]*$/;

type ResidueAccumulator = {
  readonly discarded: string[];
  readonly retained: Array<{ path: string; reason: string }>;
};

/**
 * Removes a directory tree bottom-up without following links; a directory keeps any entry it could not
 * remove. Each directory is resolved against `boundary` when it is entered, so one replaced by a link after
 * it was listed is refused rather than followed.
 */
function removeClaudeResidueTree(
  storage: StoragePort,
  directory: string,
  boundary: string,
  residue: ResidueAccumulator,
): boolean {
  let resolved: string;
  try {
    resolved = storage.realpathSync(directory);
  } catch (error: unknown) {
    residue.retained.push({ path: directory, reason: errorMessage(error) });
    return false;
  }
  if (resolved !== boundary && !resolved.startsWith(`${boundary}${sep}`)) {
    residue.retained.push({ path: directory, reason: 'no longer resolves inside the conversation directory' });
    return false;
  }
  let entries;
  try {
    entries = storage.readdirSync(directory, { withFileTypes: true });
  } catch (error: unknown) {
    residue.retained.push({ path: directory, reason: errorMessage(error) });
    return false;
  }
  let complete = true;
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      // Re-checked at the moment of descent: an entry listed as a directory may since have been replaced by a
      // link, and descending through a link would delete outside this tree.
      let kind;
      try {
        kind = storage.lstatSync(path);
      } catch (error: unknown) {
        residue.retained.push({ path, reason: errorMessage(error) });
        complete = false;
        continue;
      }
      if (kind.isDirectory() && !kind.isSymbolicLink()) {
        if (!removeClaudeResidueTree(storage, path, boundary, residue)) complete = false;
        continue;
      }
    }
    try {
      storage.unlinkSync(path);
      residue.discarded.push(path);
    } catch (error: unknown) {
      residue.retained.push({ path, reason: errorMessage(error) });
      complete = false;
    }
  }
  if (!complete) return false;
  try {
    storage.rmdirSync(directory);
    residue.discarded.push(directory);
    return true;
  } catch (error: unknown) {
    residue.retained.push({ path: directory, reason: errorMessage(error) });
    return false;
  }
}

/**
 * Discards the directory Claude keeps beside a conversation's JSONL — `<project>/<conversationRef>/`, which
 * holds out-of-line tool results. It is found by name in every project directory rather than beside the
 * JSONL, because the JSONL is already gone when retention reaches this.
 */
export function discardClaudeSessionResidue(options: {
  readonly conversationRef: string;
  readonly projectsRoot: string;
  readonly runtime: ArtifactCleanupRuntime;
}): ProviderResidueDiscardOutcome {
  const residue: ResidueAccumulator = { discarded: [], retained: [] };
  if (!CLAUDE_CONVERSATION_REF.test(options.conversationRef)) return residue;
  const storage = options.runtime.storage;
  for (const project of safeReadDir(storage, options.projectsRoot)) {
    if (!project.isDirectory()) continue;
    const directory = join(options.projectsRoot, project.name, options.conversationRef);
    let kind;
    try {
      kind = storage.lstatSync(directory);
    } catch {
      continue;
    }
    if (!kind.isDirectory() || kind.isSymbolicLink()) continue;
    let boundary: string;
    try {
      boundary = storage.realpathSync(directory);
    } catch {
      continue;
    }
    removeClaudeResidueTree(storage, directory, boundary, residue);
  }
  return residue;
}

export const claudeArtifactCapability = managed<ClaudeProviderAccess>({
  discardArtifacts: ({ handles, runtime }) => discardRecordedArtifacts(handles, runtime),
  reconcileDiscard: ({ handles, runtime }) => Promise.resolve(reconcileRecordedArtifactDiscard(handles, runtime)),
  locateArtifact: ({ conversationRef, access, runtime }) => {
    const result = locateClaudeJsonlArtifact({
      conversationRef,
      projectsRoot: access.projectsRoot,
      storage: runtime.storage,
    });
    return result.kind === 'match' ? result.artifact.handle : null;
  },
  discardResidue: ({ conversationRef, access, runtime }) =>
    Promise.resolve(discardClaudeSessionResidue({ conversationRef, projectsRoot: access.projectsRoot, runtime })),
});
