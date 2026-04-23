import { errorMessage } from '../../../../infra/error-format.js';
import type { CorpusMarkdownFileScan, DetectedIncident, Detector } from '../corpus-scan.js';
import { REPAIR_INCIDENT_ID } from '../incident-ids.js';

const UNTERMINATED_YAML_CANONICAL = REPAIR_INCIDENT_ID.FRONTMATTER_SHAPE.UNTERMINATED_YAML;
const YAML_PARSE_ERROR_CANONICAL = REPAIR_INCIDENT_ID.FRONTMATTER_SHAPE.YAML_PARSE_ERROR;
const MISSING_REQUIRED_FIELDS_CANONICAL = REPAIR_INCIDENT_ID.FRONTMATTER_SHAPE.MISSING_REQUIRED_FIELDS;

type MissingField = 'entrySeq' | 'slug' | 'title';

export const frontmatterShapeDetector: Detector = {
  detect(corpus) {
    const incidents: DetectedIncident[] = [];

    for (const entry of corpus.markdownFiles) {
      if (entry.frontmatter.status === 'unterminated') {
        incidents.push({
          locus: 'frontmatter-shape',
          canonical: UNTERMINATED_YAML_CANONICAL,
          entryId: entry.entryId,
          signals: {
            frontmatterOpenerAtByte: 0,
            bytesAfterOpener: entry.frontmatter.rawBlock?.length ?? 0,
          },
        });
        continue;
      }

      if (entry.frontmatter.status === 'error') {
        incidents.push({
          locus: 'frontmatter-shape',
          canonical: YAML_PARSE_ERROR_CANONICAL,
          entryId: entry.entryId,
          signals: {
            message: errorMessage(entry.frontmatter.error),
          },
        });
        continue;
      }

      const missingFields = detectMissingRequiredFields(entry);
      if (missingFields.length === 0) {
        continue;
      }

      incidents.push({
        locus: 'frontmatter-shape',
        canonical: MISSING_REQUIRED_FIELDS_CANONICAL,
        entryId: entry.entryId,
        signals: {
          missingFields,
          slug: entry.slug,
          frontmatterStatus: entry.frontmatter.status,
        },
      });
    }

    return incidents;
  },
};

function detectMissingRequiredFields(entry: CorpusMarkdownFileScan): MissingField[] {
  if (entry.kind !== 'note' && entry.kind !== 'source' && entry.kind !== 'community') {
    return [];
  }

  const missingFields: MissingField[] = [];
  const record = entry.frontmatter.record;

  if (!hasPresentFrontmatterValue(record?.entrySeq)) {
    missingFields.push('entrySeq');
  }

  if (entry.activeEntryId === null) {
    missingFields.push('slug');
  }

  if (entry.kind === 'source') {
    if (!hasTrimmedText(record?.title)) {
      missingFields.push('title');
    }
  } else if (entry.title === null) {
    missingFields.push('title');
  }

  return missingFields;
}

function hasPresentFrontmatterValue(value: unknown): boolean {
  if (value === null || value === undefined) {
    return false;
  }

  if (typeof value === 'string') {
    return value.trim().length > 0;
  }

  return true;
}

function hasTrimmedText(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}
