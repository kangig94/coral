import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isRecord } from '../../../infra/json.js';
import { readCurateState } from '../state/index.js';
import { buildNoteIndexEntry, buildSourceIndexEntry } from '../../corpus/index-records.js';
import { extractBody, parseSourceFrontmatter } from '../../corpus/frontmatter.js';
import type { CorpusMarkdownFileScan, CorpusScanView } from '../../corpus/repair/corpus-scan.js';
import { computeContentSurfaceHash } from '../../corpus/snapshot.js';
import { noteMetadataHash, sourceMetadataHash } from '../../metadata-hash.js';
import { loadKbNote } from '../../read.js';
import type { KbIndexMutationLane, KbIndexState, KbRuntime } from '../../contract.js';
import {
  isNoteEntry,
  isSourceEntry,
  noteEntryId,
  sourceEntryId,
  type KbIndex,
} from '../../entry-types.js';

const INDEX_FILE = 'index.json';
const ORAMA_INDEX_FILE = 'orama-index.json';

type StoredAuthorityHashes = {
  contentHash: string;
  metadataHash: string;
};

export function mergeMutationLane(
  current: KbIndexMutationLane | null,
  next: KbIndexMutationLane | null,
): KbIndexMutationLane | null {
  if (next === null || current === 'both') {
    return current;
  }
  if (current === null || current === next) {
    return next;
  }
  return 'both';
}

function modifiedAtNs(path: string): bigint | null {
  try {
    return statSync(path, { bigint: true }).mtimeNs;
  } catch {
    return null;
  }
}

function markdownDirModifiedAfter(
  dir: string,
  files: readonly CorpusMarkdownFileScan[],
  threshold: bigint,
): boolean {
  const dirModifiedAt = modifiedAtNs(dir);
  if (dirModifiedAt !== null && dirModifiedAt > threshold) {
    return true;
  }

  return files.some((file) => fileModifiedAfter(file.path, threshold));
}

function fileModifiedAfter(filePath: string, threshold: bigint): boolean {
  const modifiedAt = modifiedAtNs(filePath);
  return modifiedAt !== null && modifiedAt > threshold;
}

function collectStoredAuthorityHashes(value: unknown, hashes: Map<string, StoredAuthorityHashes>): void {
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectStoredAuthorityHashes(entry, hashes);
    }
    return;
  }

  if (!isRecord(value)) {
    return;
  }

  const entryId = typeof value.entryId === 'string' ? value.entryId : null;
  const contentHash = typeof value.contentHash === 'string' ? value.contentHash : null;
  const metadataHash = typeof value.metadataHash === 'string' ? value.metadataHash : null;
  if (entryId !== null && contentHash !== null && metadataHash !== null) {
    hashes.set(entryId, {
      contentHash,
      metadataHash,
    });
  }

  for (const child of Object.values(value)) {
    collectStoredAuthorityHashes(child, hashes);
  }
}

function readStoredOramaAuthorityHashes(runtimeDir: string): Map<string, StoredAuthorityHashes> {
  const snapshotPath = join(runtimeDir, ORAMA_INDEX_FILE);
  try {
    const parsed = JSON.parse(readFileSync(snapshotPath, 'utf-8')) as unknown;
    const hashes = new Map<string, StoredAuthorityHashes>();
    collectStoredAuthorityHashes(parsed, hashes);
    return hashes;
  } catch {
    return new Map<string, StoredAuthorityHashes>();
  }
}

function classifyAuthorityDrift(
  previous: StoredAuthorityHashes | undefined,
  current: StoredAuthorityHashes,
  fallback: {
    contentChangedByIndex: boolean;
    metadataChangedByIndex: boolean;
    fileModifiedAfterIndex: boolean;
  },
): KbIndexMutationLane | null {
  let lane: KbIndexMutationLane | null = null;

  if (previous !== undefined) {
    if (previous.contentHash !== current.contentHash) {
      lane = mergeMutationLane(lane, 'content');
    }
    if (previous.metadataHash !== current.metadataHash) {
      lane = mergeMutationLane(lane, 'metadata');
    }
    return lane;
  }

  if (fallback.contentChangedByIndex) {
    lane = mergeMutationLane(lane, 'content');
  }
  if (fallback.metadataChangedByIndex) {
    lane = mergeMutationLane(lane, 'metadata');
  }
  if (lane === null && fallback.fileModifiedAfterIndex) {
    lane = 'content';
  }

  return lane;
}

function detectStructuredTextDrift(
  kb: Pick<KbRuntime, 'runtimeDir'>,
  scan: CorpusScanView,
  index: KbIndex,
  pendingRepairIds: ReadonlySet<string>,
  indexMtime: bigint,
): KbIndexMutationLane | null {
  const storedAuthorityHashes = readStoredOramaAuthorityHashes(kb.runtimeDir);
  let lane: KbIndexMutationLane | null = null;
  const noteSlugs = new Set<string>();
  for (const file of scan.markdownFiles) {
    if (file.kind !== 'note') {
      continue;
    }
    const note = file.slug;
    noteSlugs.add(note);
    const entryId = noteEntryId(note);
    if (pendingRepairIds.has(entryId)) {
      continue;
    }
    try {
      const loaded = loadKbNote(file.path);
      const nextEntry = buildNoteIndexEntry({
        slug: note,
        title: loaded.title,
        ...loaded.frontmatter,
      });
      const existingEntry = index.entries[entryId];
      const existing = existingEntry !== undefined && isNoteEntry(existingEntry) ? existingEntry : undefined;
      if (existing === undefined) {
        lane = mergeMutationLane(lane, 'both');
        continue;
      }
      lane = mergeMutationLane(
        lane,
        classifyAuthorityDrift(
          storedAuthorityHashes.get(entryId),
          {
            contentHash: computeContentSurfaceHash({
              title: loaded.title,
              body: loaded.body,
            }),
            metadataHash: noteMetadataHash(nextEntry),
          },
          {
            contentChangedByIndex: existing.title !== nextEntry.title,
            metadataChangedByIndex: noteMetadataHash(existing) !== noteMetadataHash(nextEntry),
            fileModifiedAfterIndex: fileModifiedAfter(file.path, indexMtime),
          },
        ),
      );
    } catch {
      return 'both';
    }
  }

  for (const entry of Object.values(index.entries)) {
    if (isNoteEntry(entry) && !noteSlugs.has(entry.slug)) {
      lane = mergeMutationLane(lane, 'both');
    }
  }

  const sourceSlugs = new Set<string>();
  for (const file of scan.markdownFiles) {
    if (file.kind !== 'source') {
      continue;
    }
    const slug = file.slug;
    sourceSlugs.add(slug);
    const entryId = sourceEntryId(slug);
    if (pendingRepairIds.has(entryId)) {
      continue;
    }
    try {
      const raw = readFileSync(file.path, 'utf-8');
      const nextEntry = buildSourceIndexEntry({
        slug,
        ...parseSourceFrontmatter(raw),
      });
      const existingEntry = index.entries[entryId];
      const existing = existingEntry !== undefined && isSourceEntry(existingEntry) ? existingEntry : undefined;
      if (existing === undefined) {
        lane = mergeMutationLane(lane, 'both');
        continue;
      }
      lane = mergeMutationLane(
        lane,
        classifyAuthorityDrift(
          storedAuthorityHashes.get(entryId),
          {
            contentHash: computeContentSurfaceHash({
              title: nextEntry.title,
              body: extractBody(raw),
            }),
            metadataHash: sourceMetadataHash(nextEntry),
          },
          {
            contentChangedByIndex: existing.title !== nextEntry.title,
            metadataChangedByIndex: sourceMetadataHash(existing) !== sourceMetadataHash(nextEntry),
            fileModifiedAfterIndex: fileModifiedAfter(file.path, indexMtime),
          },
        ),
      );
    } catch {
      return 'both';
    }
  }

  for (const entry of Object.values(index.entries)) {
    if (isSourceEntry(entry) && !sourceSlugs.has(entry.slug)) {
      lane = mergeMutationLane(lane, 'both');
    }
  }

  return lane;
}

export function detectTextArtifactRebuildInfo(
  kb: Pick<
    KbRuntime,
    | 'runtimeDir'
    | 'db'
    | 'readIndex'
    | 'notesDir'
    | 'sourcesDir'
    | 'communitiesDir'
    | 'principlesDir'
    | 'entityGraphPath'
  >,
  scan: CorpusScanView,
): {
  needsRebuild: boolean;
  externalMutation: KbIndexMutationLane | null;
} {
  const indexPath = join(kb.runtimeDir, INDEX_FILE);
  if (!existsSync(indexPath)) {
    return {
      needsRebuild: true,
      externalMutation: null,
    };
  }

  try {
    const indexMtime = statSync(indexPath, { bigint: true }).mtimeNs;
    const currentIndex = kb.readIndex();
    const pendingRepairIds = new Set((readCurateState(kb).pendingRepair ?? []).map((entry) => entry.entryId));
    let externalMutation: KbIndexMutationLane | null = null;

    if (!existsSync(kb.entityGraphPath())) {
      if (
        currentIndex !== null &&
        (Object.keys(currentIndex.entityMeta).length > 0 || currentIndex.relationships.length > 0)
      ) {
        externalMutation = mergeMutationLane(externalMutation, 'metadata');
      }
    } else if (fileModifiedAfter(kb.entityGraphPath(), indexMtime)) {
      externalMutation = mergeMutationLane(externalMutation, 'metadata');
    }

    const principleFiles = scan.markdownFiles.filter((file) => file.kind === 'principle');
    const communityFiles = scan.markdownFiles.filter((file) => file.kind === 'community');
    if (
      markdownDirModifiedAfter(kb.principlesDir(), principleFiles, indexMtime) ||
      markdownDirModifiedAfter(kb.communitiesDir(), communityFiles, indexMtime)
    ) {
      externalMutation = mergeMutationLane(externalMutation, 'metadata');
    }

    if (currentIndex !== null) {
      externalMutation = mergeMutationLane(
        externalMutation,
        detectStructuredTextDrift(kb, scan, currentIndex, pendingRepairIds, indexMtime),
      );
    }

    return {
      needsRebuild: externalMutation !== null,
      externalMutation,
    };
  } catch {
    return {
      needsRebuild: true,
      externalMutation: 'both',
    };
  }
}

export function applyLaneMutation(
  state: Pick<KbIndexState, 'contentSeq' | 'metadataSeq'>,
  lane: KbIndexMutationLane | null,
): Pick<KbIndexState, 'contentSeq' | 'metadataSeq'> {
  if (lane === null) {
    return state;
  }

  const nextSeq = Math.max(state.contentSeq, state.metadataSeq) + 1;
  return {
    contentSeq: lane === 'content' || lane === 'both' ? nextSeq : state.contentSeq,
    metadataSeq: lane === 'metadata' || lane === 'both' ? nextSeq : state.metadataSeq,
  };
}
