import { cloneEntityMetaRecord, cloneEntityRelationship, cloneKbIndex } from '../../corpus/index-records.js';
import { assertNonEmptyText, compareLocale } from '../../validation.js';
import {
  getEntry,
  isNoteEntry,
  isSourceEntry,
  parseKbEntryId,
  type EntityRelationship,
  type KbEntryId,
  type KbIndex,
} from '../../entry-types.js';
import type { EntityConsolidationDelta } from '../entity-consolidation.js';
import { uniqueTrimmedList } from '../content-normalize.js';
import type {
  ClassificationAssignment,
  ClassificationNewEntity,
  ClassificationRelationship,
  CurateClaimedEntry,
  MetadataTarget,
} from '../pipeline-types.js';
import { compareCursor } from '../state/index.js';
import { classificationEntityNameSegments, isKnownEntityType, isKnownRelationshipType } from './schema.js';

function isDescriptiveEntityName(value: string, minimumSegments = 2): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(value) && classificationEntityNameSegments(value).length >= minimumSegments;
}

function hasNonEmptyDescription(value: string): boolean {
  return value.trim().length > 0;
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

function classificationRelationshipKey(relationship: ClassificationRelationship | EntityRelationship): string {
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
  const existingEntityVocabulary = new Set(Object.keys(index.entityMeta));
  const claimedByEntryId = new Map<KbEntryId, CurateClaimedEntry>();
  for (const entry of claimedEntries) {
    claimedByEntryId.set(entry.entryId, entry);
  }

  const claimedOrder: KbEntryId[] = [];
  for (const entry of claimedEntries) {
    claimedOrder.push(entry.entryId);
  }
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

    const parsedRelated: string[] = [];
    for (const relatedEntryId of proposal.related ?? []) {
      const normalized = parseKbEntryId(relatedEntryId);
      if (normalized === null || normalized === entryId || getEntry(index, normalized) === undefined) {
        continue;
      }
      parsedRelated.push(normalized);
    }
    const related = uniqueTrimmedList(parsedRelated);
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
    const acceptedTags: string[] = [];
    for (const tag of proposal.tags) {
      if (existingEntityVocabulary.has(tag)) {
        acceptedTags.push(tag);
        continue;
      }

      const candidate = proposal.newEntities?.[tag];
      if (
        candidate === undefined ||
        !isDescriptiveEntityName(tag, 2) ||
        !isKnownEntityType(candidate.type) ||
        !hasNonEmptyDescription(candidate.description)
      ) {
        continue;
      }

      acceptedNewEntities[tag] = {
        type: candidate.type,
        description: assertNonEmptyText(candidate.description, 'description').trim(),
      };
      acceptedTags.push(tag);
    }
    const tags = uniqueTrimmedList(acceptedTags);
    const tagSet = new Set(tags);
    let principles: string[] = [];
    if (claimedEntry.kind === 'note') {
      const acceptedPrinciples: string[] = [];
      for (const principle of proposal.principles ?? []) {
        if (index.principles[principle] !== undefined) {
          acceptedPrinciples.push(principle);
        }
      }
      principles = uniqueTrimmedList(acceptedPrinciples);
    }

    const acceptedRelated: string[] = [];
    for (const relatedEntryId of proposal.related ?? []) {
      if (relatedEntryId !== entryId && getEntry(index, relatedEntryId as KbEntryId) !== undefined) {
        acceptedRelated.push(relatedEntryId);
      }
    }
    const related = uniqueTrimmedList(acceptedRelated);
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
  const entityMeta = cloneEntityMetaRecord(nextIndex.entityMeta);
  const relationships: EntityRelationship[] = [];
  const relationshipsByKey = new Map<string, number>();
  for (const relationship of nextIndex.relationships) {
    relationshipsByKey.set(classificationRelationshipKey(relationship), relationships.length);
    relationships.push(cloneEntityRelationship(relationship));
  }

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
  const assignmentsByEntryId = new Map<KbEntryId, ClassificationAssignment>();
  for (const assignment of validatedAssignments) {
    const entryId = parseKbEntryId(assignment.entry);
    if (entryId !== null) {
      assignmentsByEntryId.set(entryId, assignment);
    }
  }

  const targets: MetadataTarget[] = [];
  for (const claimedEntry of claimedEntries) {
    const claimTimeMeta = getEntry(index, claimedEntry.entryId);
    const claimTimeCuratableMeta =
      claimTimeMeta !== undefined && (isNoteEntry(claimTimeMeta) || isSourceEntry(claimTimeMeta))
        ? claimTimeMeta
        : undefined;
    const existingRelated = new Set(claimTimeCuratableMeta?.related ?? []);
    const assignment = assignmentsByEntryId.get(claimedEntry.entryId);
    const desiredTags = assignment === undefined ? undefined : uniqueTrimmedList(assignment.tags);
    const desiredTagSet = new Set(desiredTags ?? []);
    const removeTags: string[] = [];
    if (desiredTags !== undefined) {
      for (const tag of claimTimeCuratableMeta?.tags ?? []) {
        if (!desiredTagSet.has(tag)) {
          removeTags.push(tag);
        }
      }
    }

    const acceptedRelated: string[] = [];
    for (const relatedEntryId of assignment?.related ?? []) {
      if (!existingRelated.has(relatedEntryId)) {
        acceptedRelated.push(relatedEntryId);
      }
    }
    const addRelated = uniqueTrimmedList(acceptedRelated);

    if (claimedEntry.kind === 'source') {
      targets.push({
        kind: 'source',
        entryId: claimedEntry.entryId,
        slug: claimedEntry.slug,
        ...(claimedEntry.entrySeq === undefined ? {} : { entrySeq: claimedEntry.entrySeq }),
        cursor: claimedEntry.cursor,
        claimTimeFingerprint: claimedEntry.claimTimeFingerprint,
        ...(desiredTags === undefined ? {} : { desiredTags }),
        ...(addRelated.length === 0 ? {} : { addRelated }),
        ...(removeTags.length === 0 ? {} : { removeTags }),
      });
      continue;
    }

    const existingPrinciples = new Set(
      claimTimeMeta !== undefined && isNoteEntry(claimTimeMeta) ? claimTimeMeta.principles : [],
    );
    const acceptedPrinciples: string[] = [];
    for (const principle of assignment?.principles ?? []) {
      if (!existingPrinciples.has(principle)) {
        acceptedPrinciples.push(principle);
      }
    }
    const addPrinciples = uniqueTrimmedList(acceptedPrinciples);

    targets.push({
      kind: 'note',
      entryId: claimedEntry.entryId,
      slug: claimedEntry.slug,
      ...(claimedEntry.entrySeq === undefined ? {} : { entrySeq: claimedEntry.entrySeq }),
      cursor: claimedEntry.cursor,
      claimTimeUpdatedAt: claimedEntry.updatedAt,
      ...(desiredTags === undefined ? {} : { desiredTags }),
      ...(addRelated.length === 0 ? {} : { addRelated }),
      ...(addPrinciples.length === 0 ? {} : { addPrinciples }),
      ...(removeTags.length === 0 ? {} : { removeTags }),
    });
  }

  return targets.sort((left, right) => {
    const cursorOrder = compareCursor(left.cursor, right.cursor);
    if (cursorOrder !== 0) {
      return cursorOrder;
    }
    return compareLocale(left.entryId, right.entryId);
  });
}
