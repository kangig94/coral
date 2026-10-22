import { describe, expect, it } from 'vitest';

import { currentCoralStoreFormat } from '#src/store-format.js';
import { normalizePersistedContractReferences } from '#src/infra/persisted-contract.js';

describe('store-format-fingerprint-main', () => {
  it('preserves the approved PR 1 persisted format in PR 2', () => {
    expect(currentCoralStoreFormat().fingerprint).toBe(
      'sha256:c2f28f76ee592ccda57100eae48e2c283d7f56dee5a12f96437a7b7392393fa2',
    );
  });
  it('gives the execution journal a generation distinct from every frozen reader', () => {
    expect([
      'sha256:f14ec2988abbf0fe125a6b0c9b50cbece7104d8a82a96da149392e2f44e53f52',
      'sha256:9fd970cdcb803f517d77b133bba86ae83ef1ff662f77da8656604f32c8e67980',
      'sha256:ca97b533a127b1475b45a487793ab7183ae70620894d1ca36e193431065b2521',
    ]).not.toContain(currentCoralStoreFormat().fingerprint);
  });

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
