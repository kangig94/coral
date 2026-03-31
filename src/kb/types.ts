export type KbMatchSurface = 'filename' | 'principle' | 'tag' | 'title' | 'content';

export interface KbResult {
  note: string;
  kind: 'note' | 'source';
  title: string;
  matchedBy: KbMatchSurface[];
  tags: string[];
  principles: string[];
  snippet?: string;
}

export type KbEntryId = `note:${string}` | `source:${string}`;

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

export type EntryRecord = NoteEntry | SourceEntry;

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
  mutationSeqAtPromote?: number;
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

export type KbSearchScope = 'notes' | 'sources' | 'all';

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
  kind: 'memo' | 'note' | 'source' | 'principle';
  note: string;
  title: string;
  content: string;
  tags: string[];
  principles: string[];
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

export function isNoteEntry(entry: EntryRecord): entry is NoteEntry {
  return entry.kind === 'note';
}

export function isSourceEntry(entry: EntryRecord): entry is SourceEntry {
  return entry.kind === 'source';
}
