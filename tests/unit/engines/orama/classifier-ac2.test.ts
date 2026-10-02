import { describe, expect, it } from 'vitest';

import {
  ORAMA_INTL_TOKENIZER_IDENTITY,
  ORAMA_KIWI_TOKENIZER_IDENTITY,
  classifyProjectionMismatch,
  createOramaProjectionMetadata,
  type OramaProjectionIdentityInput,
  type OramaProjectionMetadata,
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

function metadataFor(identityInput: OramaProjectionIdentityInput): OramaProjectionMetadata {
  return createOramaProjectionMetadata(SNAPSHOT, 'artifact-digest', {}, identityInput);
}

describe('Orama AC2 projection mismatch classifier', () => {
  it('classifies matching Intl metadata as match', () => {
    expect(classifyProjectionMismatch(metadataFor(BASE_INPUT), BASE_INPUT)).toBe('match');
  });

  it('rejects a structural mismatch even during a tokenizer upgrade', () => {
    expect(
      classifyProjectionMismatch(metadataFor(BASE_INPUT), {
        ...BASE_INPUT,
        schemaVersion: BASE_INPUT.schemaVersion + 1,
        tokenizerIdentity: ORAMA_KIWI_TOKENIZER_IDENTITY,
        declaredAnalyzers: ['ko'],
      }),
    ).toBe('incompatible');
  });

  it('classifies an Intl to Kiwi upgrade as tier-only-upgrade', () => {
    expect(
      classifyProjectionMismatch(metadataFor(BASE_INPUT), {
        ...BASE_INPUT,
        tokenizerIdentity: ORAMA_KIWI_TOKENIZER_IDENTITY,
        declaredAnalyzers: ['ko'],
      }),
    ).toBe('tier-only-upgrade');
  });

  it('rejects missing metadata and an incomplete persisted identity', () => {
    expect(classifyProjectionMismatch(undefined, BASE_INPUT)).toBe('incompatible');
    const { schemaDigest: _schemaDigest, ...incompleteMetadata } = metadataFor(BASE_INPUT);
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
