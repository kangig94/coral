export type KbMatchSurface = 'filename' | 'principle' | 'tag' | 'title' | 'content';

export interface KbResult {
  path: string;
  title: string;
  matchedBy: KbMatchSurface[];
  tags: string[];
  principles: string[];
  snippet?: string;
}

export interface KbIndex {
  notes: Record<string, {
    title: string;
    tags: string[];
    principles: string[];
    source: string[];
    createdAt: string;
    updatedAt: string;
  }>;
  principles: Record<string, string>;
}

export interface KbSearchResponse {
  results: KbResult[];
  mode: 'basic' | 'enhanced';
  warning?: string;
}

export interface KbNoteFrontmatter {
  tags: string[];
  principles: string[];
  source: string[];
  createdAt: string;
  updatedAt: string;
}

export interface KbNoteIdentity {
  note: string;
  domain: string;
  topic: string;
}

export interface KbLanceDbAdapter {
  getDb(): Promise<unknown>;
  ensureTables(): Promise<void>;
  upsertNote?(note: {
    note: string;
    path: string;
    title: string;
    body: string;
    tags: string[];
    principles: string[];
    source: string[];
    createdAt: string;
    updatedAt: string;
  }): Promise<void>;
  deleteNote?(note: string): Promise<void>;
}

export interface KbContext {
  projectRoot: string;
  kbRoot: string;
  adapter: KbLanceDbAdapter | null;
}
