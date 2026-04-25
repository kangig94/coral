import { isRecord, isStringArray } from '../../infra/json.js';
import { parseKbEntryId } from '../entry-types.js';
import { parseJsonArray, uniqueTrimmedList } from './content-normalize.js';
import type {
  ClassificationAssignment,
  ClassificationNewEntity,
  ClassificationRelationship,
} from './pipeline-types.js';
import { isKnownEntityType, isKnownRelationshipType } from './classification-schema.js';

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
