import { compareLocale } from '../../validation.js';
import type { EntityType, KbIndex, RelationshipType } from '../../entry-types.js';
import { approximateTokenCount } from '../content-normalize.js';
import type { CurateClaimedEntry } from '../pipeline-types.js';
import {
  addClassificationContextEntry,
  ClassificationVocabularyCatalog,
  cloneClassificationContext,
  createClassificationContext,
  normalizeClassificationPromptVocabulary,
  type ClassificationContext,
  type ClassificationPromptVocabularyEntry,
  type ClassificationPromptVocabularyInput,
} from './vocabulary-catalog.js';

const CLASSIFICATION_BATCH_SIZE = 100;
const CLASSIFICATION_REQUEST_TOKEN_BUDGET = 16_000;
const CLASSIFICATION_RESPONSE_TOKEN_HEADROOM = 4_000;

const ENTITY_TYPE_PROMPT_GUIDANCE: ReadonlyArray<readonly [EntityType, string]> = [
  ['technology', 'a concrete technical capability, platform, or system'],
  ['pattern', 'a reusable design or implementation approach'],
  ['concept', 'an abstract idea, model, or mental frame'],
  ['library', 'a package, framework, SDK, or API surface'],
  ['component', 'a bounded module, service, or subsystem'],
  ['domain', 'a business, product, or problem-space area'],
  ['operation', 'a workflow, procedure, or runtime activity'],
  ['quality', 'a non-functional property, constraint, or attribute'],
];

const RELATIONSHIP_TYPE_PROMPT_GUIDANCE: ReadonlyArray<readonly [RelationshipType, string]> = [
  ['enables', 'source makes target possible'],
  ['requires', 'source depends on target'],
  ['constrains', 'source limits or governs target'],
  ['implements', 'source realizes target'],
  ['specializes', 'source is a narrower form of target'],
  ['conflicts-with', 'source is incompatible with target'],
  ['precedes', 'source comes before target in time or flow'],
  ['composes', 'source contains or assembles target'],
  ['abstracts', 'source generalizes or hides target details'],
  ['replaces', 'source supersedes target'],
];

export type ClassificationBatchShape = 'source-only' | 'note-or-mixed';

type ClassificationBatchPlan = {
  entries: CurateClaimedEntry[];
  vocabulary: ClassificationPromptVocabularyEntry[];
  context: ClassificationContext;
  entryTokenTotal: number;
  shape: ClassificationBatchShape | null;
};

function buildFlatList(values: string[]): string {
  const lines: string[] = [];
  for (const value of values) {
    lines.push(`- ${value}`);
  }
  return lines.join('\n');
}

function buildGuidanceList(values: ReadonlyArray<readonly [string, string]>): string {
  const lines: string[] = [];
  for (const [type, description] of values) {
    lines.push(`${type}: ${description}`);
  }
  return buildFlatList(lines);
}

function renderClassificationPromptVocabulary(vocabulary: ClassificationPromptVocabularyInput): string {
  const normalized = normalizeClassificationPromptVocabulary(vocabulary);
  if (normalized.length === 0) {
    return '- (none yet)';
  }

  const lines: string[] = [];
  for (const entry of normalized) {
    lines.push(
      entry.relevant && entry.description
        ? `- ${entry.name}: ${entry.type} (${entry.description})`
        : `- ${entry.name}: ${entry.type}`,
    );
  }
  return lines.join('\n');
}

export function buildPrincipleNames(index: KbIndex): string[] {
  return Object.keys(index.principles).sort(compareLocale);
}

export function buildClassificationPrompt(
  entries: CurateClaimedEntry[],
  tagVocab: ClassificationPromptVocabularyInput,
  principleNames: string[],
): string {
  const shape = classificationBatchShape(entries);
  const sections = [buildClassificationPromptHeader(shape, tagVocab, principleNames)];
  for (const entry of entries) {
    sections.push(renderClassificationEntryBlock(entry));
  }
  sections.push(buildClassificationPromptFooter(shape));

  return sections.join('\n\n');
}

function classificationBatchShape(entries: CurateClaimedEntry[]): ClassificationBatchShape {
  for (const entry of entries) {
    if (entry.kind === 'note') {
      return 'note-or-mixed';
    }
  }
  return 'source-only';
}

function renderClassificationEntryBlock(entry: CurateClaimedEntry): string {
  return `## ${entry.entryId}\n${entry.title}\n${entry.body}`;
}

function buildClassificationPromptHeader(
  shape: ClassificationBatchShape,
  tagVocab: ClassificationPromptVocabularyInput,
  principleNames: string[],
): string {
  const normalizedVocabulary = normalizeClassificationPromptVocabulary(tagVocab);
  const lines = [
    'Return raw JSON only. Do not include any preamble, explanation, or code fences.',
    'Use KB entry IDs exactly as written, including the note:/source: prefix. Never return bare slugs.',
    'Tags must be descriptive entity names in lowercase kebab-case. Prefer 2-4 words and avoid bare keywords.',
    'If you introduce a tag that is not already in the existing entity vocabulary, include it in newEntities with a valid type and a one-sentence description.',
    "Extract directed relationships observed in the document between tags assigned to the same entry. Only use relationship types from the relationship vocabulary. Relationship source and target must both appear in that entry's tags.",
    'Entity type vocabulary:',
    buildGuidanceList(ENTITY_TYPE_PROMPT_GUIDANCE),
    'Relationship type vocabulary:',
    buildGuidanceList(RELATIONSHIP_TYPE_PROMPT_GUIDANCE),
    'Existing entity vocabulary:',
    renderClassificationPromptVocabulary(normalizedVocabulary),
    normalizedVocabulary.length === 0
      ? 'No existing entity vocabulary is available yet. Create newEntities when the document introduces distinct entities.'
      : 'Reuse existing entity names when they fit. Only introduce newEntities for genuinely new entities.',
  ];

  if (shape === 'source-only') {
    lines.push(
      'Each source entry must return tags, related, newEntities, and relationships. Omit principles or return [].',
    );
    return lines.join('\n\n');
  }

  lines.push('Principle names:', buildFlatList(principleNames));
  lines.push('Use only principle names from the principle list.');
  lines.push(
    'Each note entry must return tags, principles, related, newEntities, and relationships. Source entries in the same batch return tags, related, newEntities, and relationships; omit principles or return [].',
  );
  return lines.join('\n\n');
}

function buildClassificationPromptFooter(shape: ClassificationBatchShape): string {
  return shape === 'source-only'
    ? 'Return a JSON array: [{ "entry": "source:<slug>", "tags": ["<entity-name>", ...], "related": ["source:<slug>", "note:<slug>"], "newEntities": { "<entity-name>": { "type": "<entity-type>", "description": "<one sentence>" } }, "relationships": [{ "source": "<entity-name>", "target": "<entity-name>", "type": "<relationship-type>", "description": "<one sentence>" }] }]'
    : 'Return a JSON array: [{ "entry": "note:<slug>", "tags": ["<entity-name>", ...], "principles": ["<principle>", ...], "related": ["source:<slug>", "note:<slug>"], "newEntities": { "<entity-name>": { "type": "<entity-type>", "description": "<one sentence>" } }, "relationships": [{ "source": "<entity-name>", "target": "<entity-name>", "type": "<relationship-type>", "description": "<one sentence>" }] }]';
}

function classificationPromptTokenLimit(): number {
  const promptTokenLimit = CLASSIFICATION_REQUEST_TOKEN_BUDGET - CLASSIFICATION_RESPONSE_TOKEN_HEADROOM;
  if (promptTokenLimit < 1) {
    throw new Error('Classification request budget must leave positive response headroom.');
  }

  return promptTokenLimit;
}

function estimateClassificationScaffoldTokens(
  shape: ClassificationBatchShape,
  tagVocab: ClassificationPromptVocabularyInput,
  principleNames: string[],
): number {
  return approximateTokenCount(
    [buildClassificationPromptHeader(shape, tagVocab, principleNames), buildClassificationPromptFooter(shape)].join(
      '\n\n',
    ),
  );
}

function estimateClassificationEntryTokens(entry: CurateClaimedEntry): number {
  return approximateTokenCount(`\n\n${renderClassificationEntryBlock(entry)}`);
}

function estimateClassificationBatchTokensForTotals(
  shape: ClassificationBatchShape,
  entryTokenTotal: number,
  tagVocab: ClassificationPromptVocabularyInput,
  principleNames: string[],
): number {
  return estimateClassificationScaffoldTokens(shape, tagVocab, principleNames) + entryTokenTotal;
}

function classificationBatchShapeWithEntry(
  currentShape: ClassificationBatchShape | null,
  entry: CurateClaimedEntry,
): ClassificationBatchShape {
  return currentShape === 'note-or-mixed' || entry.kind === 'note' ? 'note-or-mixed' : 'source-only';
}

function createClassificationBatchPlan(): ClassificationBatchPlan {
  return {
    entries: [],
    vocabulary: [],
    context: createClassificationContext(),
    entryTokenTotal: 0,
    shape: null,
  };
}

function extendClassificationBatchPlan(
  plan: ClassificationBatchPlan,
  entry: CurateClaimedEntry,
  index: KbIndex,
  vocabularyCatalog: ClassificationVocabularyCatalog,
): ClassificationBatchPlan {
  const context = cloneClassificationContext(plan.context);
  addClassificationContextEntry(context, entry, index);

  return {
    entries: [...plan.entries, entry],
    vocabulary: vocabularyCatalog.select(context),
    context,
    entryTokenTotal: plan.entryTokenTotal + estimateClassificationEntryTokens(entry),
    shape: classificationBatchShapeWithEntry(plan.shape, entry),
  };
}

function createSingleSourceClassificationBatchPlan(
  entry: Extract<CurateClaimedEntry, { kind: 'source' }>,
  index: KbIndex,
  vocabularyCatalog: ClassificationVocabularyCatalog,
): ClassificationBatchPlan {
  const context = createClassificationContext();
  addClassificationContextEntry(context, entry, index);

  return {
    entries: [entry],
    vocabulary: vocabularyCatalog.select(context),
    context,
    entryTokenTotal: estimateClassificationEntryTokens(entry),
    shape: 'source-only',
  };
}

export function estimateClassificationBatchTokens(
  entries: CurateClaimedEntry[],
  tagVocab: ClassificationPromptVocabularyInput,
  principleNames: string[],
): number {
  const shape = classificationBatchShape(entries);
  let entryTokenTotal = 0;
  for (const entry of entries) {
    entryTokenTotal += estimateClassificationEntryTokens(entry);
  }
  return estimateClassificationBatchTokensForTotals(shape, entryTokenTotal, tagVocab, principleNames);
}

function assertClassificationScaffoldFits(
  shape: ClassificationBatchShape,
  tagVocab: ClassificationPromptVocabularyInput,
  principleNames: string[],
): void {
  if (estimateClassificationScaffoldTokens(shape, tagVocab, principleNames) > classificationPromptTokenLimit()) {
    throw new Error(`Classification ${shape} scaffold exceeds the request budget.`);
  }
}

function fitSourceEntryToPromptBudget(
  entry: Extract<CurateClaimedEntry, { kind: 'source' }>,
  tagVocab: ClassificationPromptVocabularyInput,
  principleNames: string[],
): Extract<CurateClaimedEntry, { kind: 'source' }> {
  if (estimateClassificationBatchTokens([entry], tagVocab, principleNames) <= classificationPromptTokenLimit()) {
    return entry;
  }

  let low = 0;
  let high = entry.body.length;
  let bestBody: string | null = null;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = {
      ...entry,
      body: entry.body.slice(0, mid).trimEnd(),
    };

    if (estimateClassificationBatchTokens([candidate], tagVocab, principleNames) <= classificationPromptTokenLimit()) {
      bestBody = candidate.body;
      low = mid + 1;
      continue;
    }

    high = mid - 1;
  }

  if (bestBody === null) {
    throw new Error(`Classification source entry ${entry.entryId} exceeds the request budget.`);
  }

  return {
    ...entry,
    body: bestBody,
  };
}

export function chunkEntriesByPromptBudget(
  entries: CurateClaimedEntry[],
  tagVocab: ClassificationPromptVocabularyInput,
  principleNames: string[],
  maxEntries = CLASSIFICATION_BATCH_SIZE,
): CurateClaimedEntry[][] {
  if (!Number.isInteger(maxEntries) || maxEntries < 1) {
    throw new Error('maxEntries must be a positive integer');
  }

  if (entries.length === 0) {
    return [];
  }

  let hasSource = false;
  let hasNote = false;
  for (const entry of entries) {
    hasSource ||= entry.kind === 'source';
    hasNote ||= entry.kind === 'note';
  }

  if (hasSource) {
    assertClassificationScaffoldFits('source-only', tagVocab, principleNames);
  }
  if (hasNote) {
    assertClassificationScaffoldFits('note-or-mixed', tagVocab, principleNames);
  }

  const batches: CurateClaimedEntry[][] = [];
  let index = 0;
  let currentBatch: CurateClaimedEntry[] = [];
  let currentEntryTokenTotal = 0;
  let currentShape: ClassificationBatchShape | null = null;
  const promptLimit = classificationPromptTokenLimit();

  while (index < entries.length) {
    const entry = entries[index];
    let canFit = false;
    let candidateEntryTokenTotal = currentEntryTokenTotal;
    let candidateShape: ClassificationBatchShape | null = currentShape;

    if (currentBatch.length < maxEntries) {
      candidateEntryTokenTotal += estimateClassificationEntryTokens(entry);
      candidateShape = classificationBatchShapeWithEntry(currentShape, entry);
      canFit =
        estimateClassificationBatchTokensForTotals(
          candidateShape,
          candidateEntryTokenTotal,
          tagVocab,
          principleNames,
        ) <= promptLimit;
    }

    if (canFit) {
      currentBatch.push(entry);
      currentEntryTokenTotal = candidateEntryTokenTotal;
      currentShape = candidateShape;
      index += 1;
      continue;
    }

    if (currentBatch.length > 0) {
      batches.push(currentBatch);
      currentBatch = [];
      currentEntryTokenTotal = 0;
      currentShape = null;
      continue;
    }

    if (entry.kind === 'note') {
      throw new Error(`Classification note entry ${entry.entryId} exceeds the request budget.`);
    }

    const fittedEntry = fitSourceEntryToPromptBudget(entry, tagVocab, principleNames);
    currentBatch = [fittedEntry];
    currentEntryTokenTotal = estimateClassificationEntryTokens(fittedEntry);
    currentShape = 'source-only';
    index += 1;
  }

  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }

  return batches;
}

export function takeClassificationBatchWithIndex(
  entries: CurateClaimedEntry[],
  index: KbIndex,
  principleNames: string[],
  maxEntries = CLASSIFICATION_BATCH_SIZE,
): {
  batch: CurateClaimedEntry[];
  vocabulary: ClassificationPromptVocabularyEntry[];
} {
  if (!Number.isInteger(maxEntries) || maxEntries < 1) {
    throw new Error('maxEntries must be a positive integer');
  }

  if (entries.length === 0) {
    return {
      batch: [],
      vocabulary: [],
    };
  }

  let plan = createClassificationBatchPlan();
  const vocabularyCatalog = ClassificationVocabularyCatalog.fromIndex(index);
  const promptLimit = classificationPromptTokenLimit();
  let indexCursor = 0;

  while (indexCursor < entries.length) {
    const entry = entries[indexCursor];
    const candidate = extendClassificationBatchPlan(plan, entry, index, vocabularyCatalog);
    assertClassificationScaffoldFits(candidate.shape ?? 'source-only', candidate.vocabulary, principleNames);

    if (
      plan.entries.length < maxEntries &&
      estimateClassificationBatchTokensForTotals(
        candidate.shape ?? 'source-only',
        candidate.entryTokenTotal,
        candidate.vocabulary,
        principleNames,
      ) <= promptLimit
    ) {
      plan = candidate;
      indexCursor += 1;
      continue;
    }

    if (plan.entries.length > 0) {
      break;
    }

    if (entry.kind === 'note') {
      throw new Error(`Classification note entry ${entry.entryId} exceeds the request budget.`);
    }

    const fittedEntry = fitSourceEntryToPromptBudget(entry, candidate.vocabulary, principleNames);
    plan = createSingleSourceClassificationBatchPlan(fittedEntry, index, vocabularyCatalog);
    assertClassificationScaffoldFits('source-only', plan.vocabulary, principleNames);
    break;
  }

  return {
    batch: plan.entries,
    vocabulary: plan.vocabulary,
  };
}
