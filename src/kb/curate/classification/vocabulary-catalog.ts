import { deriveNoteIdentity } from '../../corpus/frontmatter.js';
import { getEntry, type EntityType, type KbIndex } from '../../entry-types.js';
import { compareLocale } from '../../validation.js';
import { approximateTokenCount, uniqueTrimmedList } from '../content-normalize.js';
import type { CurateClaimedEntry } from '../pipeline-types.js';
import { classificationEntityNameSegments } from './schema.js';

const CLASSIFICATION_ENTITY_VOCAB_TOKEN_LIMIT = 4_000;

export type ClassificationPromptVocabularyEntry = {
  name: string;
  type: EntityType;
  description: string;
  relevant: boolean;
  support: number;
};

export type ClassificationPromptVocabularyInput = readonly string[] | readonly ClassificationPromptVocabularyEntry[];

export type ClassificationContext = {
  liveTags: Set<string>;
  tokenSet: Set<string>;
};

type ClassificationVocabularyCandidate = {
  name: string;
  type: EntityType;
  description: string;
  support: number;
  relatedEntities: readonly string[];
  relevantLineTokens: number;
  defaultLineTokens: number;
};

export class ClassificationVocabularyCatalog {
  private constructor(private readonly candidates: readonly ClassificationVocabularyCandidate[]) {}

  static fromIndex(index: KbIndex): ClassificationVocabularyCatalog {
    const candidates = buildClassificationVocabularyCandidates(index);
    candidates.sort((left, right) => right.support - left.support || compareLocale(left.name, right.name));
    return new ClassificationVocabularyCatalog(candidates);
  }

  select(context: ClassificationContext): ClassificationPromptVocabularyEntry[] {
    const relevantCandidates: ClassificationVocabularyCandidate[] = [];
    const fallbackCandidates: ClassificationVocabularyCandidate[] = [];
    for (const candidate of this.candidates) {
      if (isClassificationVocabularyCandidateRelevant(candidate, context)) {
        relevantCandidates.push(candidate);
        continue;
      }
      fallbackCandidates.push(candidate);
    }

    const selected: ClassificationPromptVocabularyEntry[] = [];
    let consumedTokens = 0;
    const appendCandidate = (candidate: ClassificationVocabularyCandidate, relevant: boolean) => {
      const lineTokens = relevant ? candidate.relevantLineTokens : candidate.defaultLineTokens;
      if (selected.length > 0 && consumedTokens + lineTokens > CLASSIFICATION_ENTITY_VOCAB_TOKEN_LIMIT) {
        return;
      }

      selected.push({
        name: candidate.name,
        type: candidate.type,
        description: candidate.description,
        relevant,
        support: candidate.support,
      });
      consumedTokens += lineTokens;
    };

    for (const candidate of relevantCandidates) {
      appendCandidate(candidate, true);
    }
    for (const candidate of fallbackCandidates) {
      appendCandidate(candidate, false);
    }
    return selected;
  }
}

export function createClassificationContext(): ClassificationContext {
  return {
    liveTags: new Set<string>(),
    tokenSet: new Set<string>(),
  };
}

export function cloneClassificationContext(context: ClassificationContext): ClassificationContext {
  return {
    liveTags: new Set(context.liveTags),
    tokenSet: new Set(context.tokenSet),
  };
}

export function addClassificationContextEntry(
  context: ClassificationContext,
  entry: CurateClaimedEntry,
  index: KbIndex,
): void {
  const addTokens = (value: string) => {
    for (const token of tokenizeLowercaseText(value)) {
      context.tokenSet.add(token);
    }
  };

  const liveEntry = getEntry(index, entry.entryId);
  if (liveEntry !== undefined && 'tags' in liveEntry) {
    for (const tag of liveEntry.tags) {
      context.liveTags.add(tag);
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

export function normalizeClassificationPromptVocabulary(
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

    const lineTokens = promptVocabularyLineTokens(entry, entry.relevant);
    if (normalized.length > 0 && consumedTokens + lineTokens > CLASSIFICATION_ENTITY_VOCAB_TOKEN_LIMIT) {
      continue;
    }

    seen.add(entry.name);
    normalized.push(entry);
    consumedTokens += lineTokens;
  }

  return normalized;
}

function buildClassificationVocabularyCandidates(index: KbIndex): ClassificationVocabularyCandidate[] {
  const entityMetaEntries = Object.entries(index.entityMeta);
  if (entityMetaEntries.length === 0) {
    return [];
  }

  const support = buildEntitySupportMap(index);
  const relationshipNeighbors = buildRelationshipNeighborMap(index);
  const candidates: ClassificationVocabularyCandidate[] = [];
  for (const [name, meta] of entityMetaEntries) {
    candidates.push({
      name,
      type: meta.type,
      description: meta.description,
      support: support.get(name) ?? 0,
      relatedEntities: [...(relationshipNeighbors.get(name) ?? [])],
      relevantLineTokens: approximateTokenCount(
        renderPromptVocabularyLine({ name, type: meta.type, description: meta.description }, true),
      ),
      defaultLineTokens: approximateTokenCount(
        renderPromptVocabularyLine({ name, type: meta.type, description: meta.description }, false),
      ),
    });
  }

  return candidates;
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

  for (const relationship of index.relationships) {
    const evidenceCount = uniqueTrimmedList(relationship.evidence).length;
    if (evidenceCount === 0) {
      continue;
    }

    support.set(relationship.source, (support.get(relationship.source) ?? 0) + evidenceCount);
    support.set(relationship.target, (support.get(relationship.target) ?? 0) + evidenceCount);
  }

  return support;
}

function buildRelationshipNeighborMap(index: KbIndex): Map<string, Set<string>> {
  const relationshipNeighbors = new Map<string, Set<string>>();
  const addNeighbor = (entityName: string, relatedEntityName: string) => {
    const existing = relationshipNeighbors.get(entityName);
    if (existing !== undefined) {
      existing.add(relatedEntityName);
      return;
    }

    relationshipNeighbors.set(entityName, new Set([relatedEntityName]));
  };

  for (const relationship of index.relationships) {
    addNeighbor(relationship.source, relationship.target);
    addNeighbor(relationship.target, relationship.source);
  }

  return relationshipNeighbors;
}

function isClassificationVocabularyCandidateRelevant(
  candidate: ClassificationVocabularyCandidate,
  context: ClassificationContext,
): boolean {
  if (context.liveTags.has(candidate.name)) {
    return true;
  }

  for (const relatedEntity of candidate.relatedEntities) {
    if (context.liveTags.has(relatedEntity)) {
      return true;
    }
  }

  for (const segment of classificationEntityNameSegments(candidate.name)) {
    if (context.tokenSet.has(segment)) {
      return true;
    }
  }

  return false;
}

function promptVocabularyLineTokens(entry: ClassificationPromptVocabularyEntry, relevant: boolean): number {
  return approximateTokenCount(renderPromptVocabularyLine(entry, relevant));
}

function renderPromptVocabularyLine(
  entry: Pick<ClassificationPromptVocabularyEntry, 'name' | 'type' | 'description'>,
  relevant: boolean,
): string {
  return relevant && entry.description
    ? `- ${entry.name}: ${entry.type} (${entry.description})`
    : `- ${entry.name}: ${entry.type}`;
}

function tokenizeLowercaseText(value: string): string[] {
  return value.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}
