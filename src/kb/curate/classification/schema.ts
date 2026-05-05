import { ENTITY_TYPES, RELATIONSHIP_TYPES, type EntityType, type RelationshipType } from '../../entry-types.js';

export function isKnownEntityType(value: string): value is EntityType {
  return (ENTITY_TYPES as readonly string[]).includes(value);
}

export function isKnownRelationshipType(value: string): value is RelationshipType {
  return (RELATIONSHIP_TYPES as readonly string[]).includes(value);
}

export function classificationEntityNameSegments(value: string): string[] {
  const segments: string[] = [];
  for (const segment of value.split('-')) {
    if (segment.length > 0) {
      segments.push(segment);
    }
  }
  return segments;
}
