import { expect, it } from 'vitest';
import { sameEpochOrFallbackAddress } from '#src/store/epoch/identity.js';

const address = (fields: Record<string, string>) => JSON.stringify(fields);

it.each([
  [address({ storeRoot: '/s', epoch: '7', path: '/s/epoch-7/store.db' }), true],
  [address({ storeRoot: '/s', epoch: '8', path: '/s/epoch-8/store.db' }), false],
  [address({ storeRoot: '/other', epoch: '7', path: '/other/epoch-7/store.db' }), false],
  [address({ storeRoot: '/s', epoch: '7', lineageKey: 'L:2' }), false],
])('names a lineage-less fallback hold %s as the epoch at its store root and number: %s', (hold, same) => {
  expect(sameEpochOrFallbackAddress(hold, address({ storeRoot: '/s', epoch: '7', lineageKey: 'L:7' }))).toBe(same);
});
