import { describe, expect, it } from 'vitest';

import {
  ORAMA_INTL_TOKENIZER_IDENTITY,
  ORAMA_KIWI_TOKENIZER_IDENTITY,
  classifyProjectionMismatch,
  createOramaProjectionMetadata,
  type OramaProjectionIdentityInput,
  type OramaProjectionMetadata,
  type OramaProjectionMismatchClassification,
} from '#src/engines/orama/artifact-port.js';
import type { KbCorpusSnapshot } from '#src/kb/contract.js';

const SNAPSHOT: KbCorpusSnapshot = {
  snapshotId: 'snapshot-ac2',
  contentSeq: 1,
  metadataSeq: 1,
  contentManifestHash: 'content-manifest',
  metadataManifestHash: 'metadata-manifest',
};

const BASE_SCHEMA = { id: 'orama-ac2-schema' };
const BASE_INPUT = {
  identitySchemaVersion: 7,
  schemaVersion: 11,
  schema: BASE_SCHEMA,
  schemaDigest: 'schema-digest-a',
  nodeVersion: 'node-a',
  icuVersion: 'icu-a',
  tokenizerIdentity: ORAMA_INTL_TOKENIZER_IDENTITY,
  declaredAnalyzers: [],
} satisfies OramaProjectionIdentityInput;

type DiscriminatingField =
  | 'identitySchemaVersion'
  | 'schemaVersion'
  | 'schemaDigest'
  | 'nodeVersion'
  | 'icuVersion'
  | 'tokenizerIdentity'
  | 'declaredAnalyzers';

const STRUCTURAL_FIELDS: readonly DiscriminatingField[] = [
  'identitySchemaVersion',
  'schemaVersion',
  'schemaDigest',
  'nodeVersion',
  'icuVersion',
];

const ALL_DISCRIMINATING_FIELDS: readonly DiscriminatingField[] = [
  ...STRUCTURAL_FIELDS,
  'tokenizerIdentity',
  'declaredAnalyzers',
];

function metadataFor(identityInput: OramaProjectionIdentityInput): OramaProjectionMetadata {
  return createOramaProjectionMetadata(SNAPSHOT, 'artifact-digest', {}, identityInput);
}

function expectedWithMismatches(mismatches: readonly DiscriminatingField[]): OramaProjectionIdentityInput {
  let expected: OramaProjectionIdentityInput = { ...BASE_INPUT };

  for (const mismatch of mismatches) {
    switch (mismatch) {
      case 'identitySchemaVersion':
        expected = { ...expected, identitySchemaVersion: BASE_INPUT.identitySchemaVersion + 1 };
        break;
      case 'schemaVersion':
        expected = { ...expected, schemaVersion: BASE_INPUT.schemaVersion + 1 };
        break;
      case 'schemaDigest':
        expected = { ...expected, schema: { id: 'orama-ac2-schema-b' }, schemaDigest: 'schema-digest-b' };
        break;
      case 'nodeVersion':
        expected = { ...expected, nodeVersion: 'node-b' };
        break;
      case 'icuVersion':
        expected = { ...expected, icuVersion: 'icu-b' };
        break;
      case 'tokenizerIdentity':
        expected = { ...expected, tokenizerIdentity: ORAMA_KIWI_TOKENIZER_IDENTITY };
        break;
      case 'declaredAnalyzers':
        expected = { ...expected, declaredAnalyzers: ['ko'] };
        break;
    }
  }

  return expected;
}

function combinations<T>(values: readonly T[]): readonly (readonly T[])[] {
  const rows: T[][] = [];
  for (let mask = 0; mask < 1 << values.length; mask += 1) {
    const row: T[] = [];
    for (let index = 0; index < values.length; index += 1) {
      if ((mask & (1 << index)) !== 0) {
        row.push(values[index]);
      }
    }
    rows.push(row);
  }
  return rows;
}

function expectedClassificationFor(mismatches: readonly DiscriminatingField[]): OramaProjectionMismatchClassification {
  if (mismatches.length === 0) {
    return 'match';
  }
  if (mismatches.some((field) => STRUCTURAL_FIELDS.includes(field))) {
    return 'incompatible';
  }
  if (mismatches.includes('tokenizerIdentity')) {
    return 'tier-only-upgrade';
  }
  return 'incompatible';
}

const mismatchCases = combinations(ALL_DISCRIMINATING_FIELDS).map((mismatches) => ({
  name: mismatches.length === 0 ? 'no mismatch' : mismatches.join(' + '),
  mismatches,
  expected: expectedClassificationFor(mismatches),
}));

describe('Orama AC2 projection mismatch classifier', () => {
  it.each(mismatchCases)('classifies $name as $expected', ({ mismatches, expected }) => {
    expect(classifyProjectionMismatch(metadataFor(BASE_INPUT), expectedWithMismatches(mismatches))).toBe(expected);
  });

  it.each([
    { name: 'cached metadata undefined', metadata: undefined },
    {
      name: 'retired metadata missing discriminating identity fields',
      metadata: (() => {
        const metadata = { ...metadataFor(BASE_INPUT) } as Record<string, unknown>;
        for (const field of ALL_DISCRIMINATING_FIELDS) {
          delete metadata[field];
        }
        return metadata as OramaProjectionMetadata;
      })(),
    },
  ])('classifies $name as incompatible', ({ metadata }) => {
    expect(classifyProjectionMismatch(metadata, BASE_INPUT)).toBe('incompatible');
  });

  it.each(ALL_DISCRIMINATING_FIELDS)('classifies metadata missing %s as incompatible', (field) => {
    const incompleteMetadata = { ...metadataFor(BASE_INPUT) } as Record<string, unknown>;
    delete incompleteMetadata[field];

    expect(classifyProjectionMismatch(incompleteMetadata as OramaProjectionMetadata, BASE_INPUT)).toBe('incompatible');
  });

  it('classifies a Kiwi persisted index with matching Kiwi expected input as match', () => {
    const kiwiInput = {
      ...BASE_INPUT,
      tokenizerIdentity: ORAMA_KIWI_TOKENIZER_IDENTITY,
      declaredAnalyzers: ['ko'],
    } satisfies OramaProjectionIdentityInput;

    expect(classifyProjectionMismatch(metadataFor(kiwiInput), kiwiInput)).toBe('match');
  });

  it('classifies persisted Kiwi tier under degraded Intl expected input as incompatible', () => {
    const kiwiInput = {
      ...BASE_INPUT,
      tokenizerIdentity: ORAMA_KIWI_TOKENIZER_IDENTITY,
      declaredAnalyzers: ['ko'],
    } satisfies OramaProjectionIdentityInput;
    const degradedExpected = {
      ...BASE_INPUT,
      declaredAnalyzers: ['ko'],
      tokenizerIdentity: ORAMA_INTL_TOKENIZER_IDENTITY,
    } satisfies OramaProjectionIdentityInput;

    expect(classifyProjectionMismatch(metadataFor(kiwiInput), degradedExpected)).toBe('incompatible');
  });

  it('treats null ICU as complete metadata when expected input also has null ICU', () => {
    const nullIcuInput = { ...BASE_INPUT, icuVersion: null } satisfies OramaProjectionIdentityInput;

    expect(classifyProjectionMismatch(metadataFor(nullIcuInput), nullIcuInput)).toBe('match');
  });
});
