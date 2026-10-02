import { describe, expect, it } from 'vitest';

import { normalizePersistedContractReferences } from '#src/infra/persisted-contract.js';

describe('store-format-fingerprint-main', () => {
  it('compares shared and repeated persisted-contract nodes by meaning', () => {
    const shared = {
      $id: 0,
      left: { $id: 1, type: 'string' },
      right: { $ref: 1 },
    };
    const repeated = {
      $id: 0,
      left: { $id: 1, type: 'string' },
      right: { $id: 2, type: 'string' },
    };

    expect(normalizePersistedContractReferences(shared)).toStrictEqual(normalizePersistedContractReferences(repeated));
  });
});
