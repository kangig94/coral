import { assertCommunitySlug, assertNoteSlug, assertSourceSlug } from './validation.js';

export type KbMatchSurface = 'filename' | 'principle' | 'tag' | 'title' | 'content';

export interface KbResult {
  note: string;
  kind: 'note' | 'source' | 'community';
  title: string;
  matchedBy: KbMatchSurface[];
  tags: string[];
  principles: string[];
  snippet?: string;
}

export type KbEntryId = `note:${string}` | `source:${string}` | `community:${string}`;

export type NoteEntry = KbNoteFrontmatter & {
  kind: 'note';
  slug: string;
  title: string;
};

export interface KbSourceFrontmatter {
  title: string;
  type: string;
  tags: string[];
  url?: string;
  importedAt: string;
  entrySeq?: number;
  related?: string[];
}

export type KbSourcePersistInput = {
  slug: string;
  stagedPath: string;
  meta: KbSourceFrontmatter;
};

export type KbSourceDeleteInput = {
  slug: string;
};

export type KbSourceListItem = KbSourceFrontmatter & {
  slug: string;
};

export type KbSourceListResult = {
  sources: KbSourceListItem[];
};

export type SourceEntry = KbSourceFrontmatter & {
  kind: 'source';
  slug: string;
};

export interface CommunityFrontmatter {
  level: number;
  members: string[];
  parent?: string;
  summary?: string;
  generatedBy: 'curate';
  createdAt: string;
  updatedAt: string;
}

export type CommunityEntry = CommunityFrontmatter & {
  kind: 'community';
  slug: string;
  title: string;
};

export type EntryRecord = NoteEntry | SourceEntry | CommunityEntry;
export type CuratableEntry = NoteEntry | SourceEntry;

export interface KbIndex {
  entries: Record<string, EntryRecord>;
  principles: Record<string, string>;
}

export interface KbSearchResponse {
  results: KbResult[];
  mode: 'text' | 'hybrid';
  warning?: string;
}

export type ReindexResult = {
  notes: number;
  sources: number;
  communities: number;
  principles: number;
  tags: number;
  duration_ms: number;
  mode: 'text' | 'hybrid';
  warning?: string;
};

export interface KbNoteFrontmatter {
  tags: string[];
  principles: string[];
  source: string[];
  createdAt: string;
  updatedAt: string;
  entrySeq?: number;
  related?: string[];
}

export interface KbNoteIdentity {
  note: string;
  domain: string;
  topic: string;
}

export type KbReindexNoteRecord = KbNoteFrontmatter & {
  note: string;
  path: string;
  domain: string;
  title: string;
  body: string;
};

export type KbReindexSourceRecord = KbSourceFrontmatter & {
  slug: string;
  path: string;
  body: string;
};

export type KbReindexCommunityRecord = CommunityFrontmatter & {
  slug: string;
  path: string;
  title: string;
  body: string;
};

export interface KbLanceDbAdapter {
  getDb(): Promise<unknown>;
  ensureTables(): Promise<void>;
}

// KB operation input types (plain types, no Zod dependency)

export type KbSearchInput = {
  query: string;
  top_k?: number;
  scope?: KbSearchScope;
};

export type KbSearchScope = 'notes' | 'sources' | 'communities' | 'all';

export type KbPromoteInput = {
  memo: string;
  title: string;
  content: string;
  domain: string;
  topic: string;
};

export type KbUpdateInput = {
  note: string;
  title?: string;
  content?: string;
};

export type KbReadInput = {
  note: string;
};

export type KbReadResult = {
  kind: 'memo' | 'note' | 'source' | 'community' | 'principle';
  note: string;
  title: string;
  content: string;
  tags: string[];
  principles: string[];
  members?: string[];
  summary?: string;
  updatedAt?: string;
  rawContent?: string;
};

export type KbDeleteInput = {
  note: string;
};

export type KbReindexInput = Record<string, never>;

export type KbPrinciplesInput = {
  query?: string;
  top_k?: number;
  verbose?: boolean;
};

export type KbPrincipleVerboseRow = {
  name: string;
  statement: string;
  notes: string[];
};

export type KbPrinciplesResult = {
  principles: string[] | KbPrincipleVerboseRow[];
  total: number;
  warning?: string;
};

export type KbMemoInput = {
  topic: string;
  content: string;
  owner: string;
};

export type KbMemoListInput = {
  owner?: string;
};

export type KbMemoListResult = {
  memos: Array<{ filename: string; summary: string; createdAt: string; owner?: string }>;
};

export type KbMemoDeleteInput = {
  pattern: string;
  owner?: string;
};

export type KbMemoDeleteResult = {
  deleted: string[];
  count: number;
};

export type KbMemoPurgeInput = {
  owner?: string;
};

export type KbMemoPurgeResult = {
  deleted: number;
};

export function noteEntryId(slug: string): KbEntryId {
  return `note:${slug}`;
}

export function sourceEntryId(slug: string): KbEntryId {
  return `source:${slug}`;
}

export function communityEntryId(slug: string): KbEntryId {
  return `community:${slug}`;
}

export function parseKbEntryId(value: string): KbEntryId | null {
  if (value.startsWith('note:')) {
    try {
      return noteEntryId(assertNoteSlug(value.slice('note:'.length), 'entryId'));
    } catch {
      return null;
    }
  }

  if (value.startsWith('source:')) {
    try {
      return sourceEntryId(assertSourceSlug(value.slice('source:'.length), 'entryId'));
    } catch {
      return null;
    }
  }

  if (value.startsWith('community:')) {
    try {
      return communityEntryId(assertCommunitySlug(value.slice('community:'.length), 'entryId'));
    } catch {
      return null;
    }
  }

  return null;
}

export function entryIdToVaultLink(id: KbEntryId): string {
  if (id.startsWith('note:')) {
    return `[[notes/${id.slice('note:'.length)}]]`;
  }

  if (id.startsWith('source:')) {
    return `[[sources/${id.slice('source:'.length)}]]`;
  }

  return `[[communities/${id.slice('community:'.length)}]]`;
}

export function vaultLinkToEntryId(link: string): KbEntryId | null {
  const match = link.trim().match(/^\[\[(notes|sources|communities)\/([^[\]\/]+)\]\]$/);
  if (match === null) {
    return null;
  }

  if (match[1] === 'notes') {
    try {
      return noteEntryId(assertNoteSlug(match[2], 'vault link'));
    } catch {
      return null;
    }
  }

  if (match[1] === 'sources') {
    try {
      return sourceEntryId(assertSourceSlug(match[2], 'vault link'));
    } catch {
      return null;
    }
  }

  try {
    return communityEntryId(assertCommunitySlug(match[2], 'vault link'));
  } catch {
    return null;
  }
}

export function entrySeqFromRecord(entry: CuratableEntry): number | undefined {
  return entry.entrySeq;
}

export function getEntry(index: KbIndex, id: KbEntryId): EntryRecord | undefined {
  return index.entries[id];
}

export function setEntry(index: KbIndex, id: KbEntryId, entry: EntryRecord): void {
  index.entries[id] = entry;
}

export function deleteEntry(index: KbIndex, id: KbEntryId): boolean {
  if (!(id in index.entries)) return false;
  delete index.entries[id];
  return true;
}

export function isNoteEntry(entry: EntryRecord): entry is NoteEntry {
  return entry.kind === 'note';
}

export function isSourceEntry(entry: EntryRecord): entry is SourceEntry {
  return entry.kind === 'source';
}

export function isCommunityEntry(entry: EntryRecord): entry is CommunityEntry {
  return entry.kind === 'community';
}
