import type { CorpusMarkdownFileScan, DetectedIncident, Detector } from '../types.js';

const ENTRYSEQ_COLLISION_CANONICAL = 'identity-sequence/entryseq-collision';
const ENTRYSEQ_FORMAT_CANONICAL = 'identity-sequence/entryseq-format';

const QUOTED_DECIMAL_PATTERN = /(?:^|\r?\n)\s*entrySeq:\s*(["'])([0-9]+)\1\s*(?:#.*)?(?=\r?\n|$)/;
const LEADING_ZERO_PATTERN = /(?:^|\r?\n)\s*entrySeq:\s*(0[0-9]+)\s*(?:#.*)?(?=\r?\n|$)/;

type EntrySeqObservation = {
  entryId: string;
  activeEntryId: string;
  value: number;
  source: 'parsed-number' | 'quoted-decimal' | 'leading-zeros' | 'string-decimal';
};

export const identitySequenceDetector: Detector = {
  detect(corpus) {
    const incidents: DetectedIncident[] = [];
    const observations: EntrySeqObservation[] = [];

    for (const entry of corpus.markdownFiles) {
      if (entry.kind !== 'note' && entry.kind !== 'source') {
        continue;
      }

      const formatIncident = detectEntrySeqFormat(entry);
      if (formatIncident !== null) {
        incidents.push(formatIncident);
      }

      const observation = observeEntrySeq(entry);
      if (observation !== null) {
        observations.push(observation);
      }
    }

    const collisions = groupCollisions(observations);
    for (const collision of collisions) {
      for (const claimant of collision.claimants) {
        incidents.push({
          locus: 'identity-sequence',
          canonical: ENTRYSEQ_COLLISION_CANONICAL,
          entryId: claimant.entryId,
          signals: {
            entrySeq: collision.entrySeq,
            colliders: collision.claimants.map((entry) => entry.activeEntryId),
          },
        });
      }
    }

    return incidents;
  },
};

function detectEntrySeqFormat(entry: CorpusMarkdownFileScan): DetectedIncident | null {
  if (entry.frontmatter.status !== 'parsed' || entry.frontmatter.record === null) {
    return null;
  }

  if (!Object.prototype.hasOwnProperty.call(entry.frontmatter.record, 'entrySeq')) {
    return null;
  }

  const rawBlock = entry.frontmatter.rawBlock ?? '';
  const quotedDecimal = rawBlock.match(QUOTED_DECIMAL_PATTERN);
  const leadingZeros = rawBlock.match(LEADING_ZERO_PATTERN);
  const parsedValue = entry.frontmatter.record.entrySeq;
  const reasons: string[] = [];

  if (quotedDecimal !== null) {
    reasons.push('quoted-decimal');
  }
  if (leadingZeros !== null) {
    reasons.push('leading-zeros');
  }
  if (reasons.length === 0 && !isCanonicalEntrySeqValue(parsedValue)) {
    reasons.push('structural-invalid');
  }

  if (reasons.length === 0) {
    return null;
  }

  const normalizedValue = observationValue(entry);

  return {
    locus: 'identity-sequence',
    canonical: ENTRYSEQ_FORMAT_CANONICAL,
    entryId: entry.entryId,
    signals: {
      reasons,
      ...(quotedDecimal === null ? {} : { quotedDecimal: quotedDecimal[0].trim() }),
      ...(leadingZeros === null ? {} : { leadingZeros: leadingZeros[0].trim() }),
      parsedType: describeType(parsedValue),
      ...(normalizedValue === null ? {} : { normalizedValue }),
    },
  };
}

function observeEntrySeq(entry: CorpusMarkdownFileScan): EntrySeqObservation | null {
  if (entry.frontmatter.status !== 'parsed' || entry.frontmatter.record === null || entry.activeEntryId === null) {
    return null;
  }

  const rawBlock = entry.frontmatter.rawBlock ?? '';
  const quotedDecimal = rawBlock.match(QUOTED_DECIMAL_PATTERN);
  if (quotedDecimal !== null) {
    const value = Number.parseInt(quotedDecimal[2] ?? '', 10);
    if (Number.isSafeInteger(value) && value > 0) {
      return {
        entryId: entry.entryId,
        activeEntryId: entry.activeEntryId,
        value,
        source: 'quoted-decimal',
      };
    }
  }

  const leadingZeros = rawBlock.match(LEADING_ZERO_PATTERN);
  if (leadingZeros !== null) {
    const value = Number.parseInt(leadingZeros[1] ?? '', 10);
    if (Number.isSafeInteger(value) && value > 0) {
      return {
        entryId: entry.entryId,
        activeEntryId: entry.activeEntryId,
        value,
        source: 'leading-zeros',
      };
    }
  }

  const parsedValue = entry.frontmatter.record.entrySeq;
  if (typeof parsedValue === 'number' && Number.isSafeInteger(parsedValue) && parsedValue > 0) {
    return {
      entryId: entry.entryId,
      activeEntryId: entry.activeEntryId,
      value: parsedValue,
      source: 'parsed-number',
    };
  }

  if (typeof parsedValue === 'string' && /^[0-9]+$/.test(parsedValue.trim())) {
    const value = Number.parseInt(parsedValue, 10);
    if (Number.isSafeInteger(value) && value > 0) {
      return {
        entryId: entry.entryId,
        activeEntryId: entry.activeEntryId,
        value,
        source: 'string-decimal',
      };
    }
  }

  return null;
}

function observationValue(entry: CorpusMarkdownFileScan): number | null {
  return observeEntrySeq(entry)?.value ?? null;
}

function isCanonicalEntrySeqValue(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function describeType(value: unknown): string {
  if (Array.isArray(value)) {
    return 'array';
  }

  if (value === null) {
    return 'null';
  }

  return typeof value;
}

function groupCollisions(observations: readonly EntrySeqObservation[]): Array<{
  entrySeq: number;
  claimants: EntrySeqObservation[];
}> {
  const grouped = new Map<number, EntrySeqObservation[]>();

  for (const observation of observations) {
    const current = grouped.get(observation.value);
    if (current === undefined) {
      grouped.set(observation.value, [observation]);
      continue;
    }

    current.push(observation);
  }

  return [...grouped.entries()]
    .filter(([, claimants]) => claimants.length > 1)
    .sort(([left], [right]) => left - right)
    .map(([entrySeq, claimants]) => ({
      entrySeq,
      claimants: [...claimants].sort((left, right) => left.activeEntryId.localeCompare(right.activeEntryId)),
    }));
}
