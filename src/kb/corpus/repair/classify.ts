import type { DetectedIncident } from './types.js';
import { REPAIR_INCIDENT_ID, type RepairIncidentId } from './incident-ids.js';

export type IncidentClassification = 'auto-fixable' | 'needs-manual' | 'unrecoverable';

const INCIDENT_CLASSIFICATIONS = {
  [REPAIR_INCIDENT_ID.FILE_SYNTAX.CONFLICT_MARKERS]: 'needs-manual',
  [REPAIR_INCIDENT_ID.FILE_SYNTAX.MALFORMED_MARKDOWN]: 'needs-manual',
  [REPAIR_INCIDENT_ID.FRONTMATTER_SHAPE.UNTERMINATED_YAML]: 'needs-manual',
  [REPAIR_INCIDENT_ID.FRONTMATTER_SHAPE.YAML_PARSE_ERROR]: 'needs-manual',
  [REPAIR_INCIDENT_ID.FRONTMATTER_SHAPE.MISSING_REQUIRED_FIELDS]: 'needs-manual',
  [REPAIR_INCIDENT_ID.IDENTITY_SEQUENCE.ENTRYSEQ_COLLISION]: 'needs-manual',
  [REPAIR_INCIDENT_ID.IDENTITY_SEQUENCE.ENTRYSEQ_FORMAT]: 'auto-fixable',
  [REPAIR_INCIDENT_ID.REFERENCE_INTEGRITY.ORPHAN_ENTITY_GRAPH_REFS]: 'auto-fixable',
  [REPAIR_INCIDENT_ID.REFERENCE_INTEGRITY.ORPHAN_PRINCIPLE_REFS]: 'needs-manual',
} as const satisfies Readonly<Record<RepairIncidentId, IncidentClassification>>;

/** Maps a detected repair incident to the automation policy Coral should apply. */
export function classifyIncident(incident: DetectedIncident): IncidentClassification {
  return INCIDENT_CLASSIFICATIONS[incident.canonical] ?? 'unrecoverable';
}
