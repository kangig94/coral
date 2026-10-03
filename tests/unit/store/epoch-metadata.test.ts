import { describe, expect, it } from 'vitest';

import { parseStoreEpochMetadata } from '#src/store/epoch/index.js';

const build = {
  version: '0.10.10',
  buildSetId: '123e4567-e89b-42d3-a456-426614174000',
  bundleHash: '0123456789abcdef',
  flavor: 'prod',
  storeFormatFingerprint: 'sha256:test',
};

describe('store epoch metadata compatibility', () => {
  it('accepts the v0.10.10 metadata shape', () => {
    const metadata = {
      supersedes: '1',
      classification: { kind: 'unavailable' },
      build,
      publishedAt: '2026-09-22T00:00:00.000Z',
    };

    expect(parseStoreEpochMetadata(metadata)).toEqual(metadata);
  });

  it('accepts additive abandonment details in current metadata', () => {
    const metadata = {
      supersedes: '1',
      classification: {
        kind: 'unavailable',
        stage: 'writable-open',
        cause: { code: 'ERR_SQLITE_ERROR', errcode: 5, message: 'database is locked', attempts: 6 },
      },
      build,
      publishedAt: '2026-09-22T00:00:00.000Z',
    };

    expect(parseStoreEpochMetadata(metadata)).toEqual(metadata);
  });
});

it.each(['version', 'buildSetId', 'bundleHash', 'storeFormatFingerprint'])(
  'rejects an empty epoch build %s',
  (field) => {
    expect(
      parseStoreEpochMetadata({
        supersedes: null,
        classification: { kind: 'absent' },
        build: { ...build, [field]: '' },
        publishedAt: '2026-09-22T00:00:00.000Z',
      }),
    ).toBeNull();
  },
);

it.each(['', 'not-a-date'])('rejects an invalid epoch publication timestamp: %s', (publishedAt) => {
  expect(
    parseStoreEpochMetadata({ supersedes: null, classification: { kind: 'absent' }, build, publishedAt }),
  ).toBeNull();
});
