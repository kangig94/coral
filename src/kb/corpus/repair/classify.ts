import type { DetectedIncident } from './types.js';

export type IncidentClassification = 'auto-fixable' | 'needs-manual' | 'unrecoverable';

const INCIDENT_CLASSIFICATIONS: Readonly<
  Record<DetectedIncident['locus'], Readonly<Record<string, IncidentClassification>>>
> = {
  'file-syntax': {
    'file-syntax/conflict-markers': 'needs-manual',
    'file-syntax/malformed-markdown': 'needs-manual',
  },
  'frontmatter-shape': {
    'frontmatter-shape/unterminated-yaml': 'needs-manual',
    'frontmatter-shape/yaml-parse-error': 'needs-manual',
    'frontmatter-shape/missing-required-fields': 'needs-manual',
  },
  'identity-sequence': {
    'identity-sequence/entryseq-collision': 'needs-manual',
    'identity-sequence/entryseq-format': 'auto-fixable',
  },
  'reference-integrity': {
    'reference-integrity/orphan-entity-graph-refs': 'auto-fixable',
    'reference-integrity/orphan-principle-refs': 'needs-manual',
  },
};

export function classifyIncident(incident: DetectedIncident): IncidentClassification {
  return INCIDENT_CLASSIFICATIONS[incident.locus][incident.canonical] ?? 'unrecoverable';
}
