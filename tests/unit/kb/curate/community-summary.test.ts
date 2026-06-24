import { describe, expect, it } from 'vitest';

import type { KbRuntime } from '#src/kb/contract.js';
import type { KbIndex } from '#src/kb/entry-types.js';
import {
  buildCommunitySummaryInput,
  computeCommunitySummaryInputFingerprints,
} from '#src/kb/curate/community/summary.js';

const EMPTY_INDEX: KbIndex = {
  entries: {},
  principles: {},
  entityMeta: {},
  relationships: [],
};

const FAKE_KB: Pick<KbRuntime, 'notePath' | 'sourcePath' | 'storagePort'> = {
  notePath: () => '',
  sourcePath: () => '',
  storagePort: {} as KbRuntime['storagePort'],
};

describe('community summary dependency graph', () => {
  it('rejects cyclic parent/child dependencies before computing summary inputs', () => {
    const alpha = {
      slug: 'alpha',
      title: 'Alpha',
      level: 1,
      members: ['alpha'],
      children: ['beta'],
      summary: 'Alpha summary.',
    };
    const beta = {
      slug: 'beta',
      title: 'Beta',
      level: 1,
      members: ['beta'],
      children: ['alpha'],
      summary: 'Beta summary.',
    };
    const communities = [alpha, beta];

    expect(() => computeCommunitySummaryInputFingerprints(communities, FAKE_KB, EMPTY_INDEX)).toThrow(
      /Cyclic community hierarchy: alpha -> beta -> alpha/,
    );
    expect(() =>
      buildCommunitySummaryInput(
        alpha,
        new Map(communities.map((community) => [community.slug, community])),
        FAKE_KB,
        EMPTY_INDEX,
      ),
    ).toThrow(/Cyclic community hierarchy: alpha -> beta -> alpha/);
  });
});
