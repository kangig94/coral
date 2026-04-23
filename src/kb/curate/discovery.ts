import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isRecord, isStringArray } from '../../infra/json.js';
import { assertNoteSlug, compareLocale } from '../validation.js';
import { isNoteEntry, noteEntryId, type KbIndex, type NoteEntry } from '../entry-types.js';
import { filterCandidatesBeforeRepairFrontier } from './metadata-commit.js';
import { parseJsonArray, uniqueTrimmedList } from './content-normalize.js';
import {
  compareCursor,
  getCurateRepairFrontier,
  normalizeCurateStateRepairFrontier,
  noteCursor,
  type CurateCursor,
  type CurateState,
} from './state.js';
import type {
  DiscoveryCurateClaimedEntry,
  DiscoveryProposal,
  NoteClaimCandidate,
} from './types.js';

const DISCOVERY_NEW_NOTE_THRESHOLD = 50;
const DISCOVERY_BATCH_SIZE = 100;
const DISCOVERY_PROMPT_BODY_LIMIT = 4000;
const DISCOVERY_MAX_MERGES = 2;
const DISCOVERY_MAX_REFINES = 3;

export type DiscoveryBatch = {
  selected: NoteClaimCandidate[];
  nextHighSeq: number;
  nextOffset: number;
};

export type PreparedDiscoveryBatch = {
  batch: DiscoveryBatch;
  processedThrough: CurateCursor;
  state: CurateState;
};

export type DiscoveryPromptResult = {
  prompt: string;
  corpusPath: string;
};

export function truncateDiscoveryBody(body: string): string {
  return body.slice(0, DISCOVERY_PROMPT_BODY_LIMIT);
}

export function extractDiscoveryProposals(entries: unknown[]): DiscoveryProposal[] {
  const proposals: DiscoveryProposal[] = [];
  for (const entry of entries) {
    if (
      !isRecord(entry) ||
      typeof entry.slug !== 'string' ||
      typeof entry.statement !== 'string' ||
      !isStringArray(entry.notes) ||
      (entry.absorbs !== undefined && !isStringArray(entry.absorbs))
    ) {
      continue;
    }

    proposals.push({
      slug: entry.slug,
      statement: entry.statement,
      notes: [...entry.notes],
      ...(entry.absorbs === undefined ? {} : { absorbs: [...entry.absorbs] }),
    });
  }

  return proposals;
}

export function normalizeDiscoverySlug(raw: string): string | null {
  try {
    return assertNoteSlug(raw, 'slug');
  } catch {
    return null;
  }
}

function getDiscoveryNotes(index: KbIndex): NoteEntry[] {
  return Object.values(index.entries).filter(isNoteEntry);
}

function collectDiscoveryCandidates(index: KbIndex): NoteClaimCandidate[] {
  return getDiscoveryNotes(index)
    .flatMap((noteMeta) =>
      noteMeta.entrySeq === undefined
        ? []
        : [
            {
              kind: 'note' as const,
              entryId: noteEntryId(noteMeta.slug),
              slug: noteMeta.slug,
              updatedAt: noteMeta.updatedAt,
              cursor: noteCursor(noteMeta.slug, noteMeta.entrySeq),
            },
          ],
    )
    .sort((left, right) => compareCursor(left.cursor, right.cursor));
}

export function sameDiscoverySelection(left: NoteClaimCandidate[], right: NoteClaimCandidate[]): boolean {
  return (
    left.length === right.length &&
    left.every((candidate, index) => {
      const other = right[index];
      return other !== undefined && compareCursor(candidate.cursor, other.cursor) === 0;
    })
  );
}

function shouldRunDiscoveryBatch(
  newNotes: NoteClaimCandidate[],
  state: CurateState,
  processedThrough: CurateCursor,
): boolean {
  if (newNotes.length >= DISCOVERY_NEW_NOTE_THRESHOLD) {
    return true;
  }

  return state.discoveryHighSeq > 0 && newNotes.length > 0 && state.discoveryHighSeq < processedThrough.entrySeq;
}

export function prepareDiscoveryBatch(
  index: KbIndex,
  state: CurateState,
  requestedProcessedThrough: CurateCursor,
): PreparedDiscoveryBatch | null {
  const normalizedState = normalizeCurateStateRepairFrontier(state);
  const currentProcessedThrough = normalizedState.processedThrough;
  if (currentProcessedThrough === null) {
    return null;
  }
  const processedThrough =
    compareCursor(requestedProcessedThrough, currentProcessedThrough) <= 0
      ? requestedProcessedThrough
      : currentProcessedThrough;

  const repairFrontier = getCurateRepairFrontier(normalizedState.pendingRepair);
  const allClassified = filterCandidatesBeforeRepairFrontier(
    collectDiscoveryCandidates(index).filter((candidate) => compareCursor(candidate.cursor, processedThrough) <= 0),
    repairFrontier,
  );
  const newNotes = allClassified.filter((candidate) => candidate.cursor.entrySeq > normalizedState.discoveryHighSeq);
  if (!shouldRunDiscoveryBatch(newNotes, normalizedState, processedThrough)) {
    return null;
  }

  return {
    batch: selectDiscoveryBatch(allClassified, normalizedState.discoveryHighSeq, normalizedState.discoveryOffset),
    processedThrough,
    state: normalizedState,
  };
}

export function selectDiscoveryBatch(
  allClassified: NoteClaimCandidate[],
  highSeq: number,
  offset: number,
): DiscoveryBatch {
  const newNotes = allClassified.filter((candidate) => candidate.cursor.entrySeq > highSeq);
  const oldNotes = allClassified.filter((candidate) => candidate.cursor.entrySeq <= highSeq);
  const selected = newNotes.slice(0, DISCOVERY_BATCH_SIZE);

  let nextOffset = offset;
  if (selected.length < DISCOVERY_BATCH_SIZE && oldNotes.length > 0) {
    const fill = Math.min(DISCOVERY_BATCH_SIZE - selected.length, oldNotes.length);
    const start = offset % oldNotes.length;
    for (let index = 0; index < fill; index += 1) {
      selected.push(oldNotes[(start + index) % oldNotes.length]);
    }
    nextOffset = (start + fill) % oldNotes.length;
  }

  const nextHighSeq = selected.reduce((max, candidate) => Math.max(max, candidate.cursor.entrySeq), highSeq);
  return { selected, nextHighSeq, nextOffset };
}

export function buildDiscoveryPrompt(
  notes: DiscoveryCurateClaimedEntry[],
  existingPrinciples: Record<string, string>,
): DiscoveryPromptResult {
  const noteBlocks = notes.map((note) => `## ${note.slug}\n${note.title}\n${truncateDiscoveryBody(note.body)}`);
  const corpusPath = join(tmpdir(), `coral-discovery-${randomUUID()}.md`);
  writeFileSync(corpusPath, noteBlocks.join('\n\n'));

  const principleEntries = Object.entries(existingPrinciples)
    .sort(([left], [right]) => compareLocale(left, right))
    .map(([name, statement]) => `- ${name}: ${statement}`);

  const prompt = [
    'Return raw JSON only. Do not include any preamble, explanation, or code fences.',
    '',
    'Principles are cross-domain reusable decision rules extracted from recurring patterns across notes. Each principle is:',
    '- A judgment call that applies beyond its original context',
    '- Actionable: what to do or avoid',
    '- Seen independently in at least 3 notes',
    '- One sentence',
    '',
    "Look for recurring mistakes, structural patterns, or decision heuristics that appear across multiple unrelated notes. Do not propose principles that merely restate a single note's content.",
    '',
    'Existing principles (name: statement). Do not duplicate or propose semantically equivalent ones:',
    ...principleEntries,
    '',
    `Read the note corpus from ${corpusPath} before responding.`,
    '',
    'Return a JSON array: [{ "slug": "<kebab-case>", "statement": "<one-sentence principle>", "notes": ["<slug>", ...], "absorbs": ["<existing-slug>", ...] }]',
    "To improve an existing principle's wording, return it with its existing slug and the better statement.",
    'To merge similar principles, return the surviving slug with absorbs listing the slugs to fold in. Omit absorbs when creating new principles.',
  ].join('\n');

  return { prompt, corpusPath };
}

export function parseDiscoveryResponseResult(raw: string): {
  proposals: DiscoveryProposal[];
  parseFailed: boolean;
} {
  const { entries, parseFailed } = parseJsonArray(raw);
  return {
    proposals: parseFailed ? [] : extractDiscoveryProposals(entries),
    parseFailed,
  };
}

export function parseDiscoveryResponse(raw: string): DiscoveryProposal[] {
  return parseDiscoveryResponseResult(raw).proposals;
}

export function validateDiscoveryProposals(
  proposals: DiscoveryProposal[],
  eligibleNotes: DiscoveryCurateClaimedEntry[],
  existingPrinciples: Record<string, string>,
): DiscoveryProposal[] {
  const eligibleSet = new Set(eligibleNotes.map((note) => note.slug));
  const seenSlugs = new Set<string>();
  const seenAbsorbedSlugs = new Set<string>();
  const validated: DiscoveryProposal[] = [];
  let mergeCount = 0;
  let refineCount = 0;

  for (const proposal of proposals) {
    const slug = normalizeDiscoverySlug(proposal.slug);
    if (slug === null || seenSlugs.has(slug) || seenAbsorbedSlugs.has(slug)) {
      continue;
    }

    const statement = proposal.statement.trim();
    if (!statement) {
      continue;
    }

    const notes = uniqueTrimmedList(proposal.notes.filter((note) => eligibleSet.has(note)));
    if (notes.length < 3) {
      continue;
    }

    const absorbs = uniqueTrimmedList(proposal.absorbs ?? []);
    const normalizedAbsorbs: string[] = [];
    let invalidAbsorption = false;

    for (const rawAbsorb of absorbs) {
      const absorbSlug = normalizeDiscoverySlug(rawAbsorb);
      if (
        absorbSlug === null ||
        existingPrinciples[absorbSlug] === undefined ||
        absorbSlug === slug ||
        seenSlugs.has(absorbSlug) ||
        seenAbsorbedSlugs.has(absorbSlug)
      ) {
        invalidAbsorption = true;
        break;
      }
      normalizedAbsorbs.push(absorbSlug);
    }
    if (invalidAbsorption) {
      continue;
    }

    const existingStatement = existingPrinciples[slug];
    const isMerge = normalizedAbsorbs.length > 0;
    if (existingStatement !== undefined && existingStatement === statement && !isMerge) {
      continue;
    }

    const isRefine = existingStatement !== undefined && !isMerge;
    if (isMerge && mergeCount >= DISCOVERY_MAX_MERGES) {
      continue;
    }
    if (isRefine && refineCount >= DISCOVERY_MAX_REFINES) {
      continue;
    }

    validated.push({
      slug,
      statement,
      notes,
      ...(normalizedAbsorbs.length === 0 ? {} : { absorbs: normalizedAbsorbs }),
    });
    seenSlugs.add(slug);
    for (const absorbSlug of normalizedAbsorbs) {
      seenAbsorbedSlugs.add(absorbSlug);
    }
    if (isMerge) {
      mergeCount += 1;
    }
    if (isRefine) {
      refineCount += 1;
    }
  }

  return validated;
}

export function serializePrincipleDocument(statement: string, createdAt: string): string {
  const normalizedStatement = statement.trim();
  const normalizedCreatedAt = createdAt.trim();

  if (!normalizedStatement) {
    throw new Error('statement must be non-empty');
  }
  if (!normalizedCreatedAt) {
    throw new Error('createdAt must be non-empty');
  }

  return [
    '---',
    `createdAt: ${normalizedCreatedAt}`,
    `updatedAt: ${normalizedCreatedAt}`,
    '---',
    '',
    normalizedStatement,
    '',
  ].join('\n');
}
