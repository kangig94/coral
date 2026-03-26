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
