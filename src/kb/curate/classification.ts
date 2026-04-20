import { deriveNoteIdentity } from '../corpus/frontmatter.js';
import { cloneKbIndex, cloneEntityMetaRecord, cloneEntityRelationship } from '../corpus/mutation-helpers.js';
import { assertNonEmptyText, compareLocale } from '../validation.js';
import {
  ENTITY_TYPES,
  RELATIONSHIP_TYPES,
  getEntry,
  isNoteEntry,
  isSourceEntry,
  parseKbEntryId,
  type EntityRelationship,
  type EntityType,
  type KbEntryId,
  type KbIndex,
  type RelationshipType,
} from '../entry-types.js';
import { isRecord, isStringArray } from '../../shared/utils.js';
import { type EntityConsolidationDelta } from './entity-consolidation.js';
import { approximateTokenCount, parseJsonArray, uniqueTrimmedList } from './shared.js';
import type {
  ClassificationAssignment,
  ClassificationNewEntity,
  ClassificationRelationship,
  CurateClaimedEntry,
  MetadataTarget,
} from './types.js';

const CLASSIFICATION_BATCH_SIZE = 100;
const CLASSIFICATION_REQUEST_TOKEN_BUDGET = 16_000;
const CLASSIFICATION_RESPONSE_TOKEN_HEADROOM = 4_000;
const CLASSIFICATION_ENTITY_VOCAB_TOKEN_LIMIT = 4_000;

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

export type ClassificationPromptVocabularyEntry = {
  name: string;
  type: EntityType;
  description: string;
  relevant: boolean;
  support: number;
};

export type ClassificationPromptVocabularyInput =
  | readonly string[]
  | readonly ClassificationPromptVocabularyEntry[];

export type ClassificationBatchShape = 'source-only' | 'note-or-mixed';

function buildFlatList(values: string[]): string {
  return values.map((value) => `- ${value}`).join('\n');
}

function isKnownEntityType(value: string): value is EntityType {
  return (ENTITY_TYPES as readonly string[]).includes(value);
}

function isKnownRelationshipType(value: string): value is RelationshipType {
  return (RELATIONSHIP_TYPES as readonly string[]).includes(value);
}

function tokenizeLowercaseText(value: string): string[] {
  return value.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

function classificationEntityNameSegments(value: string): string[] {
  return value.split('-').filter((segment) => segment.length > 0);
}

function isDescriptiveEntityName(value: string, minimumSegments = 2): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(value) && classificationEntityNameSegments(value).length >= minimumSegments;
}

function hasNonEmptyDescription(value: string): boolean {
  return value.trim().length > 0;
}

function buildEntitySupportMap(index: KbIndex): Map<string, number> {
  const support = new Map<string, number>();

  for (const entry of Object.values(index.entries)) {
    if (!('tags' in entry)) {
      continue;
    }

    for (const tag of new Set(entry.tags)) {
      support.set(tag, (support.get(tag) ?? 0) + 1);
    }
  }

  for (const relationship of index.relationships ?? []) {
    const evidenceCount = uniqueTrimmedList(relationship.evidence).length;
    if (evidenceCount === 0) {
      continue;
    }

    support.set(relationship.source, (support.get(relationship.source) ?? 0) + evidenceCount);
    support.set(relationship.target, (support.get(relationship.target) ?? 0) + evidenceCount);
  }

  return support;
}

function buildClassificationContext(
  entries: CurateClaimedEntry[],
  index: KbIndex,
): {
  liveTags: Set<string>;
  tokenSet: Set<string>;
} {
  const liveTags = new Set<string>();
  const tokenSet = new Set<string>();

  const addTokens = (value: string) => {
    for (const token of tokenizeLowercaseText(value)) {
      tokenSet.add(token);
    }
  };

  for (const entry of entries) {
    const liveEntry = getEntry(index, entry.entryId);
    if (liveEntry !== undefined && 'tags' in liveEntry) {
      for (const tag of liveEntry.tags) {
        liveTags.add(tag);
        addTokens(tag);
      }
    }

    addTokens(entry.title);
    addTokens(entry.body.slice(0, 4_000));

    if (entry.kind === 'note') {
      const identity = deriveNoteIdentity(entry.slug);
      addTokens(identity.domain);
      addTokens(identity.topic);
    }
  }

  return {
    liveTags,
    tokenSet,
  };
}

function buildClassificationPromptVocabulary(
  entries: CurateClaimedEntry[],
  index: KbIndex,
): ClassificationPromptVocabularyEntry[] {
  const entityMeta = index.entityMeta ?? {};
  const entityNames = Object.keys(entityMeta);
  if (entityNames.length === 0) {
    return [];
  }

  const support = buildEntitySupportMap(index);
  const { liveTags, tokenSet } = buildClassificationContext(entries, index);
  const relationships = index.relationships ?? [];

  const ranked = entityNames
    .map((name) => {
      const meta = entityMeta[name];
      const relevantByRelationship = relationships.some(
        (relationship) =>
          (relationship.source === name && liveTags.has(relationship.target)) ||
          (relationship.target === name && liveTags.has(relationship.source)),
      );
      const relevant =
        liveTags.has(name) ||
        relevantByRelationship ||
        classificationEntityNameSegments(name).some((segment) => tokenSet.has(segment));

      return {
        name,
        type: meta.type,
        description: meta.description,
        relevant,
        support: support.get(name) ?? 0,
      };
    })
    .sort(
      (left, right) =>
        Number(right.relevant) - Number(left.relevant) ||
        right.support - left.support ||
        compareLocale(left.name, right.name),
    );

  const selected: ClassificationPromptVocabularyEntry[] = [];
  let consumedTokens = 0;

  for (const candidate of ranked) {
    const renderedLine =
      candidate.relevant && candidate.description
        ? `- ${candidate.name}: ${candidate.type} (${candidate.description})`
        : `- ${candidate.name}: ${candidate.type}`;
    const lineTokens = approximateTokenCount(renderedLine);
    if (selected.length > 0 && consumedTokens + lineTokens > CLASSIFICATION_ENTITY_VOCAB_TOKEN_LIMIT) {
      continue;
    }

    selected.push(candidate);
    consumedTokens += lineTokens;
  }

  return selected;
}

function normalizeClassificationPromptVocabulary(
  vocabulary: ClassificationPromptVocabularyInput,
): ClassificationPromptVocabularyEntry[] {
  const seen = new Set<string>();
  const normalized: ClassificationPromptVocabularyEntry[] = [];
  let consumedTokens = 0;

  for (const value of vocabulary) {
    const entry =
      typeof value === 'string'
        ? {
            name: value.trim(),
            type: 'concept' as const,
            description: '',
            relevant: false,
            support: 0,
          }
        : {
            name: value.name.trim(),
            type: value.type,
            description: value.description.trim(),
            relevant: value.relevant,
            support: value.support,
          };
    if (!entry.name || seen.has(entry.name)) {
      continue;
    }

    const renderedLine =
      entry.relevant && entry.description
        ? `- ${entry.name}: ${entry.type} (${entry.description})`
        : `- ${entry.name}: ${entry.type}`;
    const lineTokens = approximateTokenCount(renderedLine);
    if (normalized.length > 0 && consumedTokens + lineTokens > CLASSIFICATION_ENTITY_VOCAB_TOKEN_LIMIT) {
      continue;
    }

    seen.add(entry.name);
    normalized.push(entry);
    consumedTokens += lineTokens;
  }

  return normalized;
}

function renderClassificationPromptVocabulary(vocabulary: ClassificationPromptVocabularyInput): string {
  const normalized = normalizeClassificationPromptVocabulary(vocabulary);
  if (normalized.length === 0) {
    return '- (none yet)';
  }

  return normalized
    .map((entry) =>
      entry.relevant && entry.description
        ? `- ${entry.name}: ${entry.type} (${entry.description})`
        : `- ${entry.name}: ${entry.type}`,
    )
    .join('\n');
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
  const entryBlocks = entries.map(renderClassificationEntryBlock);

  return [
    buildClassificationPromptHeader(shape, tagVocab, principleNames),
    ...entryBlocks,
    buildClassificationPromptFooter(shape),
  ].join('\n\n');
}

function classificationBatchShape(entries: CurateClaimedEntry[]): ClassificationBatchShape {
  return entries.some((entry) => entry.kind === 'note') ? 'note-or-mixed' : 'source-only';
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
    buildFlatList(ENTITY_TYPE_PROMPT_GUIDANCE.map(([type, description]) => `${type}: ${description}`)),
    'Relationship type vocabulary:',
    buildFlatList(RELATIONSHIP_TYPE_PROMPT_GUIDANCE.map(([type, description]) => `${type}: ${description}`)),
    'Existing entity vocabulary:',
    renderClassificationPromptVocabulary(normalizedVocabulary),
    normalizedVocabulary.length === 0
      ? 'No existing entity vocabulary is available yet. Create newEntities when the document introduces distinct entities.'
      : 'Reuse existing entity names when they fit. Only introduce newEntities for genuinely new entities.',
  ];

  if (shape === 'source-only') {
    lines.push('Each source entry must return tags, related, newEntities, and relationships. Omit principles or return [].');
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

export function estimateClassificationBatchTokens(
  entries: CurateClaimedEntry[],
  tagVocab: ClassificationPromptVocabularyInput,
  principleNames: string[],
): number {
  const shape = classificationBatchShape(entries);
  return (
    estimateClassificationScaffoldTokens(shape, tagVocab, principleNames) +
    entries.reduce((total, entry) => total + estimateClassificationEntryTokens(entry), 0)
  );
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

function parseClassificationNewEntities(value: unknown): Record<string, ClassificationNewEntity> {
  if (!isRecord(value)) {
    return {};
  }

  const accepted: Record<string, ClassificationNewEntity> = {};
  for (const [entityName, rawMeta] of Object.entries(value)) {
    if (
      !isRecord(rawMeta) ||
      typeof rawMeta.type !== 'string' ||
      typeof rawMeta.description !== 'string' ||
      !isKnownEntityType(rawMeta.type)
    ) {
      continue;
    }

    const normalizedName = entityName.trim();
    const description = rawMeta.description.trim();
    if (!normalizedName || !description) {
      continue;
    }

    accepted[normalizedName] = {
      type: rawMeta.type,
      description,
    };
  }

  return accepted;
}

function parseClassificationRelationships(value: unknown): ClassificationRelationship[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const relationships: ClassificationRelationship[] = [];
  for (const relationship of value) {
    if (
      !isRecord(relationship) ||
      typeof relationship.source !== 'string' ||
      typeof relationship.target !== 'string' ||
      typeof relationship.type !== 'string' ||
      typeof relationship.description !== 'string' ||
      !isKnownRelationshipType(relationship.type)
    ) {
      continue;
    }

    const source = relationship.source.trim();
    const target = relationship.target.trim();
    const description = relationship.description.trim();
    if (!source || !target || !description) {
      continue;
    }

    relationships.push({
      source,
      target,
      type: relationship.type,
      description,
    });
  }

  return relationships;
}

function classifyParsedEntries(entries: unknown[], entryMap: Map<string, true>): ClassificationAssignment[] {
  const assignments: ClassificationAssignment[] = [];

  for (const entry of entries) {
    if (!isRecord(entry) || typeof entry.entry !== 'string' || !isStringArray(entry.tags)) {
      continue;
    }

    const parsedEntryId = parseKbEntryId(entry.entry);
    if (parsedEntryId === null || !entryMap.has(parsedEntryId)) {
      continue;
    }

    const principles = entry.principles === undefined ? [] : entry.principles;
    const related = entry.related === undefined ? [] : entry.related;
    if (!isStringArray(principles) || !isStringArray(related)) {
      continue;
    }
    const newEntities = parseClassificationNewEntities(entry.newEntities);
    const relationships = parseClassificationRelationships(entry.relationships);

    const normalizedRelated = uniqueTrimmedList(
      related.flatMap((relatedEntryId) => {
        const normalized = parseKbEntryId(relatedEntryId);
        return normalized === null ? [] : [normalized];
      }),
    );

    assignments.push({
      entry: parsedEntryId,
      tags: uniqueTrimmedList(entry.tags),
      principles: [...principles],
      ...(normalizedRelated.length === 0 ? {} : { related: normalizedRelated }),
      ...(Object.keys(newEntities).length === 0 ? {} : { newEntities }),
      ...(relationships.length === 0 ? {} : { relationships }),
    });
  }

  return assignments;
}

export function parseClassificationResponseResult(
  raw: string,
  entryMap: Map<string, true>,
): {
  assignments: ClassificationAssignment[];
  parseFailed: boolean;
} {
  const { entries, parseFailed } = parseJsonArray(raw);
  return {
    assignments: parseFailed ? [] : classifyParsedEntries(entries, entryMap),
    parseFailed,
  };
}

export function parseClassificationResponse(raw: string, entryMap: Map<string, true>): ClassificationAssignment[] {
  return parseClassificationResponseResult(raw, entryMap).assignments;
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

  if (entries.some((entry) => entry.kind === 'source')) {
    assertClassificationScaffoldFits('source-only', tagVocab, principleNames);
  }
  if (entries.some((entry) => entry.kind === 'note')) {
    assertClassificationScaffoldFits('note-or-mixed', tagVocab, principleNames);
  }

  const batches: CurateClaimedEntry[][] = [];
  let index = 0;
  let currentBatch: CurateClaimedEntry[] = [];

  while (index < entries.length) {
    const entry = entries[index];
    const nextBatch = [...currentBatch, entry];
    const canFit =
      currentBatch.length < maxEntries &&
      estimateClassificationBatchTokens(nextBatch, tagVocab, principleNames) <= classificationPromptTokenLimit();

    if (canFit) {
      currentBatch.push(entry);
      index += 1;
      continue;
    }

    if (currentBatch.length > 0) {
      batches.push(currentBatch);
      currentBatch = [];
      continue;
    }

    if (entry.kind === 'note') {
      throw new Error(`Classification note entry ${entry.entryId} exceeds the request budget.`);
    }

    currentBatch = [fitSourceEntryToPromptBudget(entry, tagVocab, principleNames)];
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

  let batch: CurateClaimedEntry[] = [];
  let vocabulary: ClassificationPromptVocabularyEntry[] = [];
  let indexCursor = 0;

  while (indexCursor < entries.length) {
    const entry = entries[indexCursor];
    const candidateBatch = [...batch, entry];
    const candidateVocabulary = buildClassificationPromptVocabulary(candidateBatch, index);
    assertClassificationScaffoldFits(classificationBatchShape(candidateBatch), candidateVocabulary, principleNames);

    if (
      batch.length < maxEntries &&
      estimateClassificationBatchTokens(candidateBatch, candidateVocabulary, principleNames) <=
        classificationPromptTokenLimit()
    ) {
      batch = candidateBatch;
      vocabulary = candidateVocabulary;
      indexCursor += 1;
      continue;
    }

    if (batch.length > 0) {
      break;
    }

    if (entry.kind === 'note') {
      throw new Error(`Classification note entry ${entry.entryId} exceeds the request budget.`);
    }

    const fittedEntry = fitSourceEntryToPromptBudget(entry, candidateVocabulary, principleNames);
    batch = [fittedEntry];
    vocabulary = buildClassificationPromptVocabulary(batch, index);
    assertClassificationScaffoldFits(classificationBatchShape(batch), vocabulary, principleNames);
    break;
  }

  return {
    batch,
    vocabulary,
  };
}

function mergeClassificationNewEntities(
  ...maps: Array<Record<string, ClassificationNewEntity> | undefined>
): Record<string, ClassificationNewEntity> | undefined {
  const merged: Record<string, ClassificationNewEntity> = {};

  for (const map of maps) {
    if (map === undefined) {
      continue;
    }

    for (const [entityName, meta] of Object.entries(map)) {
      if (merged[entityName] !== undefined) {
        continue;
      }

      merged[entityName] = {
        type: meta.type,
        description: meta.description,
      };
    }
  }

  return Object.keys(merged).length === 0 ? undefined : merged;
}

function classificationRelationshipKey(relationship: ClassificationRelationship): string {
  return `${relationship.source}\u0000${relationship.target}\u0000${relationship.type}`;
}

function mergeClassificationRelationships(
  ...lists: Array<ClassificationRelationship[] | undefined>
): ClassificationRelationship[] | undefined {
  const merged: ClassificationRelationship[] = [];
  const seen = new Set<string>();

  for (const list of lists) {
    if (list === undefined) {
      continue;
    }

    for (const relationship of list) {
      const key = classificationRelationshipKey(relationship);
      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      merged.push({
        source: relationship.source,
        target: relationship.target,
        type: relationship.type,
        description: relationship.description,
      });
    }
  }

  return merged.length === 0 ? undefined : merged;
}

export function validateAssignments(
  proposals: ClassificationAssignment[],
  index: KbIndex,
  claimedEntries: CurateClaimedEntry[],
): ClassificationAssignment[] {
  const existingEntityVocabulary = new Set(Object.keys(index.entityMeta ?? {}));
  const claimedByEntryId = new Map<KbEntryId, CurateClaimedEntry>();
  for (const entry of claimedEntries) {
    claimedByEntryId.set(entry.entryId, entry);
  }

  const claimedOrder = claimedEntries.map((entry) => entry.entryId);
  const mergedByEntry = new Map<KbEntryId, ClassificationAssignment>();

  for (const proposal of proposals) {
    const entryId = parseKbEntryId(proposal.entry);
    if (entryId === null) {
      continue;
    }

    const claimedEntry = claimedByEntryId.get(entryId);
    if (claimedEntry === undefined || getEntry(index, entryId) === undefined) {
      continue;
    }

    const related = uniqueTrimmedList(
      (proposal.related ?? []).flatMap((relatedEntryId) => {
        const normalized = parseKbEntryId(relatedEntryId);
        if (normalized === null || normalized === entryId || getEntry(index, normalized) === undefined) {
          return [];
        }

        return [normalized];
      }),
    );
    const existing = mergedByEntry.get(entryId);
    if (existing === undefined) {
      const mergedNewEntities = mergeClassificationNewEntities(proposal.newEntities);
      const mergedRelationships = mergeClassificationRelationships(proposal.relationships);
      mergedByEntry.set(entryId, {
        entry: entryId,
        tags: uniqueTrimmedList(proposal.tags),
        principles: uniqueTrimmedList(proposal.principles ?? []),
        ...(related.length === 0 ? {} : { related }),
        ...(mergedNewEntities === undefined ? {} : { newEntities: mergedNewEntities }),
        ...(mergedRelationships === undefined ? {} : { relationships: mergedRelationships }),
      });
      continue;
    }

    existing.tags = uniqueTrimmedList([...existing.tags, ...proposal.tags]);
    existing.principles = uniqueTrimmedList([...(existing.principles ?? []), ...(proposal.principles ?? [])]);
    existing.newEntities = mergeClassificationNewEntities(existing.newEntities, proposal.newEntities);
    existing.relationships = mergeClassificationRelationships(existing.relationships, proposal.relationships);
    if (existing.newEntities === undefined) {
      delete existing.newEntities;
    }
    if (existing.relationships === undefined) {
      delete existing.relationships;
    }
    const mergedRelated = uniqueTrimmedList([...(existing.related ?? []), ...related]);
    if (mergedRelated.length === 0) {
      delete existing.related;
    } else {
      existing.related = mergedRelated;
    }
  }

  const validated: ClassificationAssignment[] = [];
  for (const entryId of claimedOrder) {
    const proposal = mergedByEntry.get(entryId);
    const claimedEntry = claimedByEntryId.get(entryId);
    if (proposal === undefined || claimedEntry === undefined) {
      continue;
    }

    const acceptedNewEntities: Record<string, ClassificationNewEntity> = {};
    const tags = uniqueTrimmedList(
      proposal.tags.filter((tag) => {
        if (existingEntityVocabulary.has(tag)) {
          return true;
        }

        const candidate = proposal.newEntities?.[tag];
        if (
          candidate === undefined ||
          !isDescriptiveEntityName(tag, 2) ||
          !isKnownEntityType(candidate.type) ||
          !hasNonEmptyDescription(candidate.description)
        ) {
          return false;
        }

        acceptedNewEntities[tag] = {
          type: candidate.type,
          description: assertNonEmptyText(candidate.description, 'description').trim(),
        };
        return true;
      }),
    );
    const tagSet = new Set(tags);
    const principles =
      claimedEntry.kind === 'note'
        ? uniqueTrimmedList(
            (proposal.principles ?? []).filter((principle) => index.principles[principle] !== undefined),
          )
        : [];
    const related = uniqueTrimmedList(
      (proposal.related ?? []).filter(
        (relatedEntryId) => relatedEntryId !== entryId && getEntry(index, relatedEntryId as KbEntryId) !== undefined,
      ),
    );
    const relationships: ClassificationRelationship[] = [];
    const seenRelationships = new Set<string>();
    for (const relationship of proposal.relationships ?? []) {
      if (
        relationship.source === relationship.target ||
        !tagSet.has(relationship.source) ||
        !tagSet.has(relationship.target) ||
        !isKnownRelationshipType(relationship.type) ||
        !hasNonEmptyDescription(relationship.description)
      ) {
        continue;
      }

      const normalizedRelationship = {
        source: relationship.source,
        target: relationship.target,
        type: relationship.type,
        description: relationship.description.trim(),
      };
      const key = classificationRelationshipKey(normalizedRelationship);
      if (seenRelationships.has(key)) {
        continue;
      }

      seenRelationships.add(key);
      relationships.push(normalizedRelationship);
    }

    validated.push({
      entry: entryId,
      tags,
      principles,
      ...(related.length === 0 ? {} : { related }),
      ...(Object.keys(acceptedNewEntities).length === 0 ? {} : { newEntities: acceptedNewEntities }),
      ...(relationships.length === 0 ? {} : { relationships }),
    });
  }

  return validated;
}

export function mergeAssignmentsIntoIndexGraph(index: KbIndex, assignments: ClassificationAssignment[]): KbIndex {
  const nextIndex = cloneKbIndex(index);
  const entityMeta = cloneEntityMetaRecord(nextIndex.entityMeta ?? {});
  const relationships = (nextIndex.relationships ?? []).map(cloneEntityRelationship);
  const relationshipsByKey = new Map(
    relationships.map((relationship, index) => [classificationRelationshipKey(relationship), index] as const),
  );

  for (const assignment of assignments) {
    for (const [entityName, meta] of Object.entries(assignment.newEntities ?? {})) {
      if (entityMeta[entityName] !== undefined) {
        continue;
      }

      entityMeta[entityName] = {
        type: meta.type,
        description: meta.description,
      };
    }

    for (const relationship of assignment.relationships ?? []) {
      const key = classificationRelationshipKey(relationship);
      const existingIndex = relationshipsByKey.get(key);
      if (existingIndex !== undefined) {
        const existing = relationships[existingIndex];
        if (existing !== undefined) {
          existing.evidence = uniqueTrimmedList([...existing.evidence, assignment.entry]);
          if (!existing.description && relationship.description) {
            existing.description = relationship.description;
          }
        }
        continue;
      }

      relationshipsByKey.set(key, relationships.length);
      relationships.push({
        source: relationship.source,
        target: relationship.target,
        type: relationship.type,
        description: relationship.description,
        evidence: [assignment.entry],
      });
    }
  }

  nextIndex.entityMeta = entityMeta;
  nextIndex.relationships = relationships;
  return nextIndex;
}

export function buildEntityConsolidationDelta(assignments: ClassificationAssignment[]): EntityConsolidationDelta {
  const entities: NonNullable<EntityConsolidationDelta['entities']> = [];
  const relationships: EntityRelationship[] = [];

  for (const assignment of assignments) {
    for (const [name, meta] of Object.entries(assignment.newEntities ?? {})) {
      entities.push({
        name,
        type: meta.type,
        description: meta.description,
      });
    }

    for (const relationship of assignment.relationships ?? []) {
      relationships.push({
        source: relationship.source,
        target: relationship.target,
        type: relationship.type,
        description: relationship.description,
        evidence: [assignment.entry],
      });
    }
  }

  return {
    ...(entities.length === 0 ? {} : { entities }),
    ...(relationships.length === 0 ? {} : { relationships }),
  };
}

export function buildMetadataTargets(
  validatedAssignments: ClassificationAssignment[],
  index: KbIndex,
  claimedEntries: CurateClaimedEntry[],
): MetadataTarget[] {
  const assignmentsByEntryId = new Map(
    validatedAssignments.flatMap((assignment) => {
      const entryId = parseKbEntryId(assignment.entry);
      return entryId === null ? [] : [[entryId, assignment] as const];
    }),
  );
  return claimedEntries
    .map((claimedEntry) => {
      const claimTimeMeta = getEntry(index, claimedEntry.entryId);
      const claimTimeCuratableMeta =
        claimTimeMeta !== undefined && (isNoteEntry(claimTimeMeta) || isSourceEntry(claimTimeMeta))
          ? claimTimeMeta
          : undefined;
      const existingRelated = new Set(claimTimeCuratableMeta?.related ?? []);
      const assignment = assignmentsByEntryId.get(claimedEntry.entryId);
      const desiredTags = assignment === undefined ? undefined : uniqueTrimmedList(assignment.tags);
      const desiredTagSet = new Set(desiredTags ?? []);
      const removeTags =
        desiredTags === undefined ? [] : (claimTimeCuratableMeta?.tags ?? []).filter((tag) => !desiredTagSet.has(tag));
      const addRelated = uniqueTrimmedList(
        (assignment?.related ?? []).filter((relatedEntryId) => !existingRelated.has(relatedEntryId)),
      );

      if (claimedEntry.kind === 'source') {
        return {
          kind: 'source' as const,
          entryId: claimedEntry.entryId,
          slug: claimedEntry.slug,
          entrySeq: claimedEntry.entrySeq,
          claimTimeFingerprint: claimedEntry.claimTimeFingerprint,
          ...(desiredTags === undefined ? {} : { desiredTags }),
          ...(addRelated.length === 0 ? {} : { addRelated }),
          ...(removeTags.length === 0 ? {} : { removeTags }),
        };
      }

      const existingPrinciples = new Set(
        claimTimeMeta !== undefined && isNoteEntry(claimTimeMeta) ? claimTimeMeta.principles : [],
      );
      const addPrinciples = uniqueTrimmedList(
        (assignment?.principles ?? []).filter((principle) => !existingPrinciples.has(principle)),
      );

      return {
        kind: 'note' as const,
        entryId: claimedEntry.entryId,
        slug: claimedEntry.slug,
        entrySeq: claimedEntry.entrySeq,
        claimTimeUpdatedAt: claimedEntry.updatedAt,
        ...(desiredTags === undefined ? {} : { desiredTags }),
        ...(addRelated.length === 0 ? {} : { addRelated }),
        ...(addPrinciples.length === 0 ? {} : { addPrinciples }),
        ...(removeTags.length === 0 ? {} : { removeTags }),
      };
    })
    .sort((left, right) => {
      if (left.entrySeq !== right.entrySeq) {
        return left.entrySeq - right.entrySeq;
      }
      return compareLocale(left.entryId, right.entryId);
    });
}
