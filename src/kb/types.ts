export type KbMatchSurface = 'filename' | 'principle' | 'tag' | 'title' | 'content';

export interface KbResult {
  note: string;
  title: string;
  matchedBy: KbMatchSurface[];
  tags: string[];
  principles: string[];
  snippet?: string;
}

export type KbNoteIndexRecord = KbNoteFrontmatter & { title: string };

export interface KbIndex {
  notes: Record<string, KbNoteIndexRecord>;
  principles: Record<string, string>;
}

export interface KbSearchResponse {
  results: KbResult[];
  mode: 'text' | 'hybrid';
  warning?: string;
}

export type ReindexResult = {
  notes: number;
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

export interface KbLanceDbAdapter {
  getDb(): Promise<unknown>;
  ensureTables(): Promise<void>;
}

// KB operation input types (plain types, no Zod dependency)

export type KbSearchInput = {
  query: string;
  top_k?: number;
};

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

export type KbDeleteInput = {
  note: string;
};

export type KbReindexInput = Record<string, never>;

export type KbPrinciplesInput = {
  query?: string;
  top_k?: number;
};

export type KbMemoInput = {
  topic: string;
  content: string;
};
