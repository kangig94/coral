import { errorMessage, isRecord } from '../shared/mcp-utils.js';
import { readIndexState, recordIndexSyncFailure } from './detect.js';
import { searchBasic } from './search-basic.js';
import type { KbContext, KbMatchSurface, KbResult, KbSearchResponse } from './types.js';

type EnhancedMatchSurface = KbMatchSurface;

type SearchCandidate = {
  slug: string;
  path: string;
  title: string;
  body: string;
  tags: string[];
  principles: string[];
  matchedBy: Set<EnhancedMatchSurface>;
  snippet?: string;
};

type LanceDbConnection = {
  openTable: (name: string) => Promise<unknown>;
};

type LanceDbTable = {
  query: () => LanceDbQuery;
};

type LanceDbQuery = {
  where: (predicate: string) => LanceDbQuery;
  select: (columns: string[] | string) => LanceDbQuery;
  limit?: (limit: number) => LanceDbQuery;
  toArray: () => Promise<unknown[]>;
};

type NoteRow = {
  id: string;
  path: string;
  note_slug: string;
  title: string;
  body: string;
};

type TagRow = {
  note_id: string;
  tag: string;
};

type PrincipleRow = {
  note_id: string;
  principle: string;
};

const MATCH_SURFACE_ORDER: EnhancedMatchSurface[] = ['filename', 'principle', 'tag', 'title', 'content'];
const MATCH_SURFACE_PRIORITY: Record<EnhancedMatchSurface, number> = {
  filename: 0,
  principle: 1,
  tag: 2,
  title: 3,
  content: 4,
};

function asConnection(value: unknown): LanceDbConnection {
  if (
    typeof value !== 'object'
    || value === null
    || typeof (value as Partial<LanceDbConnection>).openTable !== 'function'
  ) {
    throw new Error('Invalid LanceDB connection');
  }

  return value as LanceDbConnection;
}

function asTable(value: unknown): LanceDbTable {
  if (
    typeof value !== 'object'
    || value === null
    || typeof (value as Partial<LanceDbTable>).query !== 'function'
  ) {
    throw new Error('Invalid LanceDB table');
  }

  return value as LanceDbTable;
}

function sortedMatchedBy(matchedBy: Set<EnhancedMatchSurface>): EnhancedMatchSurface[] {
  return [...matchedBy].sort((left, right) => MATCH_SURFACE_PRIORITY[left] - MATCH_SURFACE_PRIORITY[right]);
}

function compareCandidates(left: SearchCandidate, right: SearchCandidate): number {
  const countDiff = right.matchedBy.size - left.matchedBy.size;
  if (countDiff !== 0) {
    return countDiff;
  }

  for (const surface of MATCH_SURFACE_ORDER) {
    const leftHas = left.matchedBy.has(surface);
    const rightHas = right.matchedBy.has(surface);
    if (leftHas !== rightHas) {
      return leftHas ? -1 : 1;
    }
  }

  return left.slug.localeCompare(right.slug);
}

function toResult(candidate: SearchCandidate): KbResult {
  return {
    path: candidate.path,
    title: candidate.title,
    matchedBy: sortedMatchedBy(candidate.matchedBy),
    tags: [...candidate.tags],
    principles: [...candidate.principles],
    ...(candidate.snippet === undefined ? {} : { snippet: candidate.snippet }),
  };
}

function cloneCandidate(candidate: SearchCandidate): SearchCandidate {
  return {
    ...candidate,
    tags: [...candidate.tags],
    principles: [...candidate.principles],
    matchedBy: new Set(candidate.matchedBy),
  };
}

function rerank(candidates: Iterable<SearchCandidate>, topK: number): SearchCandidate[] {
  return [...candidates]
    .map(cloneCandidate)
    .sort(compareCandidates)
    .slice(0, topK);
}

function escapeSqlString(value: string): string {
  return value.replace(/'/g, "''");
}

function escapeLikeLiteral(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/%/g, '\\%')
    .replace(/_/g, '\\_');
}

function containsPredicate(column: string, query: string): string {
  return `${column} LIKE '%${escapeLikeLiteral(escapeSqlString(query))}%' ESCAPE '\\'`;
}

function equalityPredicate(column: string, query: string): string {
  return `${column} = '${escapeSqlString(query)}'`;
}

function idsPredicate(column: string, ids: string[]): string {
  return `${column} IN (${ids.map((id) => `'${escapeSqlString(id)}'`).join(', ')})`;
}

function findSentenceStart(content: string, matchIndex: number): number {
  const paragraphBoundary = content.lastIndexOf('\n\n', matchIndex);
  const sentenceBoundary = content.lastIndexOf('.', matchIndex - 1);
  if (paragraphBoundary === -1 && sentenceBoundary === -1) {
    return 0;
  }
  if (paragraphBoundary > sentenceBoundary) {
    return paragraphBoundary + 2;
  }
  return sentenceBoundary + 1;
}

function findSentenceEnd(content: string, matchIndex: number): number {
  const paragraphBoundary = content.indexOf('\n\n', matchIndex);
  const sentenceBoundary = content.indexOf('.', matchIndex);
  if (paragraphBoundary === -1 && sentenceBoundary === -1) {
    return content.length;
  }
  if (paragraphBoundary === -1) {
    return sentenceBoundary + 1;
  }
  if (sentenceBoundary === -1) {
    return paragraphBoundary;
  }
  return Math.min(paragraphBoundary, sentenceBoundary + 1);
}

function truncateSnippet(snippet: string, matchOffset: number): string {
  if (snippet.length <= 200) {
    return snippet;
  }

  const windowSize = 200;
  let start = Math.max(0, matchOffset - 80);
  let end = Math.min(snippet.length, start + windowSize);
  if (end - start < windowSize) {
    start = Math.max(0, end - windowSize);
  }

  let truncated = snippet.slice(start, end).trim();
  if (start > 0) {
    truncated = `...${truncated}`;
  }
  if (end < snippet.length) {
    truncated = `${truncated}...`;
  }
  if (truncated.length <= 200) {
    return truncated;
  }
  return truncated.slice(0, 200).trimEnd();
}

function extractSnippet(content: string, normalizedQuery: string): string | undefined {
  const normalizedContent = content.toLowerCase();
  const matchIndex = normalizedContent.indexOf(normalizedQuery);
  if (matchIndex === -1) {
    return undefined;
  }

  const sentenceStart = findSentenceStart(content, matchIndex);
  const sentenceEnd = findSentenceEnd(content, matchIndex);
  const rawSnippet = content.slice(sentenceStart, sentenceEnd).replace(/\s+/g, ' ').trim();
  if (!rawSnippet) {
    return undefined;
  }

  const normalizedSnippet = rawSnippet.toLowerCase();
  const snippetMatchIndex = normalizedSnippet.indexOf(normalizedQuery);
  return truncateSnippet(rawSnippet, snippetMatchIndex === -1 ? 0 : snippetMatchIndex);
}

async function queryRows(
  table: LanceDbTable,
  predicate: string,
  columns: string[],
): Promise<unknown[]> {
  const query = table.query().where(predicate).select(columns);
  return query.toArray();
}

function parseNoteRow(value: unknown): NoteRow {
  if (!isRecord(value)) {
    throw new Error('Invalid enhanced note row');
  }

  const { id, path, note_slug, title, body } = value;
  if (
    typeof id !== 'string'
    || typeof path !== 'string'
    || typeof note_slug !== 'string'
    || typeof title !== 'string'
    || typeof body !== 'string'
  ) {
    throw new Error('Invalid enhanced note row');
  }

  return { id, path, note_slug, title, body };
}

function parseTagRow(value: unknown): TagRow {
  if (!isRecord(value) || typeof value.note_id !== 'string' || typeof value.tag !== 'string') {
    throw new Error('Invalid enhanced tag row');
  }

  return {
    note_id: value.note_id,
    tag: value.tag,
  };
}

function parsePrincipleRow(value: unknown): PrincipleRow {
  if (!isRecord(value) || typeof value.note_id !== 'string' || typeof value.principle !== 'string') {
    throw new Error('Invalid enhanced principle row');
  }

  return {
    note_id: value.note_id,
    principle: value.principle,
  };
}

function fallbackToBasic(kb: KbContext, query: string, topK: number, warning: string): KbSearchResponse {
  const fallback = searchBasic(kb, query, topK);
  return {
    results: fallback.results,
    mode: 'basic',
    warning,
  };
}

function staleWarning(reason?: string): string {
  const detail = reason ? ` (${reason})` : '';
  return `Enhanced KB index is stale${detail}; falling back to basic search. Run kb_reindex to refresh it.`;
}

function queryFailureWarning(): string {
  return 'Enhanced KB search failed; falling back to basic search. Run kb_reindex to refresh it.';
}

export async function searchEnhanced(kb: KbContext, query: string, top_k = 20): Promise<KbSearchResponse> {
  if (kb.adapter === null) {
    return searchBasic(kb, query, top_k);
  }

  const state = readIndexState();
  if (state.indexedSeq !== state.mutationSeq || state.staleReason !== undefined) {
    return fallbackToBasic(kb, query, top_k, staleWarning(state.staleReason));
  }

  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return {
      results: [],
      mode: 'enhanced',
    };
  }

  const topK = Number.isInteger(top_k) && top_k > 0 ? top_k : 20;

  try {
    const db = asConnection(await kb.adapter.getDb());
    const notesTable = asTable(await db.openTable('notes'));
    const tagsTable = asTable(await db.openTable('tags'));
    const principlesTable = asTable(await db.openTable('principles'));

    const [filenameRows, titleRows, contentRows, tagRows, principleRows] = await Promise.all([
      queryRows(notesTable, containsPredicate('note_slug_norm', normalizedQuery), ['id', 'path', 'note_slug', 'title', 'body']),
      queryRows(notesTable, containsPredicate('title_norm', normalizedQuery), ['id', 'path', 'note_slug', 'title', 'body']),
      queryRows(notesTable, containsPredicate('body_norm', normalizedQuery), ['id', 'path', 'note_slug', 'title', 'body']),
      queryRows(tagsTable, equalityPredicate('tag_norm', normalizedQuery), ['note_id', 'tag']),
      queryRows(principlesTable, equalityPredicate('principle_norm', normalizedQuery), ['note_id', 'principle']),
    ]);

    const notesById = new Map<string, NoteRow>();
    const matchedById = new Map<string, Set<EnhancedMatchSurface>>();

    const applyNoteMatch = (rows: unknown[], surface: EnhancedMatchSurface) => {
      for (const value of rows) {
        const row = parseNoteRow(value);
        notesById.set(row.id, row);
        const matchedBy = matchedById.get(row.id) ?? new Set<EnhancedMatchSurface>();
        matchedBy.add(surface);
        matchedById.set(row.id, matchedBy);
      }
    };

    applyNoteMatch(filenameRows, 'filename');
    applyNoteMatch(titleRows, 'title');
    applyNoteMatch(contentRows, 'content');

    for (const value of tagRows) {
      const row = parseTagRow(value);
      const matchedBy = matchedById.get(row.note_id) ?? new Set<EnhancedMatchSurface>();
      matchedBy.add('tag');
      matchedById.set(row.note_id, matchedBy);
    }

    for (const value of principleRows) {
      const row = parsePrincipleRow(value);
      const matchedBy = matchedById.get(row.note_id) ?? new Set<EnhancedMatchSurface>();
      matchedBy.add('principle');
      matchedById.set(row.note_id, matchedBy);
    }

    const noteIds = [...matchedById.keys()];
    if (noteIds.length === 0) {
      return {
        results: [],
        mode: 'enhanced',
      };
    }

    const missingIds = noteIds.filter((noteId) => !notesById.has(noteId));
    if (missingIds.length > 0) {
      const rows = await queryRows(
        notesTable,
        idsPredicate('id', missingIds),
        ['id', 'path', 'note_slug', 'title', 'body'],
      );
      for (const value of rows) {
        const row = parseNoteRow(value);
        notesById.set(row.id, row);
      }
    }

    const [allTagRows, allPrincipleRows] = await Promise.all([
      queryRows(tagsTable, idsPredicate('note_id', noteIds), ['note_id', 'tag']),
      queryRows(principlesTable, idsPredicate('note_id', noteIds), ['note_id', 'principle']),
    ]);

    const tagsById = new Map<string, string[]>();
    for (const value of allTagRows) {
      const row = parseTagRow(value);
      const tags = tagsById.get(row.note_id) ?? [];
      tags.push(row.tag);
      tagsById.set(row.note_id, tags);
    }

    const principlesById = new Map<string, string[]>();
    for (const value of allPrincipleRows) {
      const row = parsePrincipleRow(value);
      const principles = principlesById.get(row.note_id) ?? [];
      principles.push(row.principle);
      principlesById.set(row.note_id, principles);
    }

    const candidates: SearchCandidate[] = [];
    for (const noteId of noteIds) {
      const note = notesById.get(noteId);
      const matchedBy = matchedById.get(noteId);
      if (note === undefined || matchedBy === undefined) {
        continue;
      }

      candidates.push({
        slug: note.note_slug,
        path: note.path,
        title: note.title,
        body: note.body,
        tags: tagsById.get(noteId) ?? [],
        principles: principlesById.get(noteId) ?? [],
        matchedBy,
        ...(matchedBy.has('content')
          ? { snippet: extractSnippet(note.body, normalizedQuery) }
          : {}),
      });
    }

    return {
      results: rerank(candidates, topK).map(toResult),
      mode: 'enhanced',
    };
  } catch (error: unknown) {
    recordIndexSyncFailure(`Enhanced KB search failed: ${errorMessage(error)}`);
    return fallbackToBasic(kb, query, topK, queryFailureWarning());
  }
}
