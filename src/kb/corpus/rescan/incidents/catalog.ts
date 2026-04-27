import type { CorpusScanView } from '../scan.js';

export const REPAIR_INCIDENT_ID = {
  FILE_SYNTAX: {
    CONFLICT_MARKERS: 'file-syntax/conflict-markers',
    MALFORMED_MARKDOWN: 'file-syntax/malformed-markdown',
  },
  FRONTMATTER_SHAPE: {
    UNTERMINATED_YAML: 'frontmatter-shape/unterminated-yaml',
    YAML_PARSE_ERROR: 'frontmatter-shape/yaml-parse-error',
    MISSING_REQUIRED_FIELDS: 'frontmatter-shape/missing-required-fields',
  },
  IDENTITY_SEQUENCE: {
    ENTRYSEQ_COLLISION: 'identity-sequence/entryseq-collision',
    ENTRYSEQ_FORMAT: 'identity-sequence/entryseq-format',
  },
  REFERENCE_INTEGRITY: {
    ORPHAN_ENTITY_GRAPH_REFS: 'reference-integrity/orphan-entity-graph-refs',
    ORPHAN_PRINCIPLE_REFS: 'reference-integrity/orphan-principle-refs',
  },
} as const;

// Iterated at compile time only — type derivation source for RepairIncidentId. Keep exported so external code can introspect the catalog if needed.
export const REPAIR_INCIDENT_IDS = [
  REPAIR_INCIDENT_ID.FILE_SYNTAX.CONFLICT_MARKERS,
  REPAIR_INCIDENT_ID.FILE_SYNTAX.MALFORMED_MARKDOWN,
  REPAIR_INCIDENT_ID.FRONTMATTER_SHAPE.UNTERMINATED_YAML,
  REPAIR_INCIDENT_ID.FRONTMATTER_SHAPE.YAML_PARSE_ERROR,
  REPAIR_INCIDENT_ID.FRONTMATTER_SHAPE.MISSING_REQUIRED_FIELDS,
  REPAIR_INCIDENT_ID.IDENTITY_SEQUENCE.ENTRYSEQ_COLLISION,
  REPAIR_INCIDENT_ID.IDENTITY_SEQUENCE.ENTRYSEQ_FORMAT,
  REPAIR_INCIDENT_ID.REFERENCE_INTEGRITY.ORPHAN_ENTITY_GRAPH_REFS,
  REPAIR_INCIDENT_ID.REFERENCE_INTEGRITY.ORPHAN_PRINCIPLE_REFS,
] as const;

export type RepairIncidentId = (typeof REPAIR_INCIDENT_IDS)[number];
export type RepairLocus = RepairIncidentId extends `${infer Locus}/${string}` ? Locus : never;
export type RepairIncidentLocus<IncidentId extends RepairIncidentId> = Extract<
  RepairLocus,
  IncidentId extends `${infer Locus}/${string}` ? Locus : never
>;

const REPAIR_INCIDENT_LOCUS: Readonly<Record<RepairIncidentId, RepairLocus>> = {
  [REPAIR_INCIDENT_ID.FILE_SYNTAX.CONFLICT_MARKERS]: 'file-syntax',
  [REPAIR_INCIDENT_ID.FILE_SYNTAX.MALFORMED_MARKDOWN]: 'file-syntax',
  [REPAIR_INCIDENT_ID.FRONTMATTER_SHAPE.UNTERMINATED_YAML]: 'frontmatter-shape',
  [REPAIR_INCIDENT_ID.FRONTMATTER_SHAPE.YAML_PARSE_ERROR]: 'frontmatter-shape',
  [REPAIR_INCIDENT_ID.FRONTMATTER_SHAPE.MISSING_REQUIRED_FIELDS]: 'frontmatter-shape',
  [REPAIR_INCIDENT_ID.IDENTITY_SEQUENCE.ENTRYSEQ_COLLISION]: 'identity-sequence',
  [REPAIR_INCIDENT_ID.IDENTITY_SEQUENCE.ENTRYSEQ_FORMAT]: 'identity-sequence',
  [REPAIR_INCIDENT_ID.REFERENCE_INTEGRITY.ORPHAN_ENTITY_GRAPH_REFS]: 'reference-integrity',
  [REPAIR_INCIDENT_ID.REFERENCE_INTEGRITY.ORPHAN_PRINCIPLE_REFS]: 'reference-integrity',
};

export function repairIncidentLocus(incidentId: RepairIncidentId): RepairLocus {
  return REPAIR_INCIDENT_LOCUS[incidentId];
}

export type DetectedIncident = {
  [IncidentId in RepairIncidentId]: {
    locus: RepairIncidentLocus<IncidentId>;
    canonical: IncidentId;
    entryId: string;
    signals: Record<string, unknown>;
  };
}[RepairIncidentId];

export interface Detector {
  detect(corpus: CorpusScanView): DetectedIncident[];
}

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
