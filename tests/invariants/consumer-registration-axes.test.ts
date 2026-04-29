// Phase 7 of apply-contract-reform plan.
//
// AC3 declared per-arm `kind` and `registrationKind` literals on all four
// arms of `ConsumerRegistration` so the two-axis rule
//   `kind: 'stateless' ⟺ registrationKind: 'stateless'`
//   `kind: 'cursor' | 'apply' ⟹ registrationKind: 'base' | 'expansion'`
// is enforced compile-time on every arm. This invariant pins that contract
// with `// @ts-expect-error` blocks the TypeScript compiler must reject,
// plus a runtime constructor probe asserting valid two-axis combinations
// are accepted by `ConsumerDriver.register()`.

import { readFileSync, readdirSync } from 'node:fs';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import type { StoragePort } from '#src/runtime/ports.js';
import { applyStoreSchemas } from '#src/store/schema-loader.js';
import { ConsumerDriver } from '#src/coordinator/consumer-driver.js';
import type {
  ConsumerRegistration,
  CorpusConsumerRegistration,
  JournalApplyRegistration,
  JournalCursorRegistration,
  StatelessProviderLifecycleRegistration,
} from '#src/store/consumer-contract.js';

const nodeStorage: Pick<StoragePort, 'readFileSync' | 'readdirSync'> = {
  readFileSync: (path, encoding) => readFileSync(path, encoding),
  readdirSync: (path, options) => readdirSync(path, options),
};

function createDb(): InstanceType<typeof Database> {
  const db = new Database(':memory:');
  applyStoreSchemas({ db, storage: nodeStorage });
  return db;
}

describe('Two-axis kind/registrationKind invariant', () => {
  it('compile-time: type system rejects every mixed two-axis combination', () => {
    // Each block below MUST be flagged by `tsc`. If the compiler stops
    // rejecting any of these, the structural invariant is broken and
    // future drift can pair (e.g.) `kind: 'stateless'` with
    // `registrationKind: 'base'` without a build error. Removing any
    // `@ts-expect-error` here documents that the compiler started
    // accepting an illegal combination — a regression.

    // Stateless kind paired with non-stateless registrationKind:
    // @ts-expect-error stateless kind requires registrationKind: 'stateless'
    const _statelessAsBase: StatelessProviderLifecycleRegistration = {
      id: 's-1',
      kind: 'stateless',
      registrationKind: 'base',
    };
    // @ts-expect-error stateless kind requires registrationKind: 'stateless'
    const _statelessAsExpansion: StatelessProviderLifecycleRegistration = {
      id: 's-2',
      kind: 'stateless',
      registrationKind: 'expansion',
    };

    // Non-stateless kind paired with registrationKind: 'stateless':
    // @ts-expect-error journal-cursor cannot pair with registrationKind: 'stateless'
    const _cursorAsStateless: JournalCursorRegistration = {
      id: 'c-1',
      authority: 'journal',
      kind: 'cursor',
      registrationKind: 'stateless',
    };
    // @ts-expect-error journal-apply cannot pair with registrationKind: 'stateless'
    const _applyAsStateless: JournalApplyRegistration = {
      id: 'a-1',
      authority: 'journal',
      kind: 'apply',
      registrationKind: 'stateless',
      apply: async () => {},
    };
    // @ts-expect-error corpus-apply cannot pair with registrationKind: 'stateless'
    const _corpusAsStateless: CorpusConsumerRegistration = {
      id: 'co-1',
      authority: 'corpus',
      kind: 'apply',
      registrationKind: 'stateless',
      corpusInterest: 'content',
      apply: async () => {},
    };

    // Stateless arm must not declare `authority` (the type pins it to
    // `never` for that arm). Adding the field is a compile error.
    // @ts-expect-error stateless arm has authority?: never
    const _statelessWithAuthority: StatelessProviderLifecycleRegistration = {
      id: 's-3',
      kind: 'stateless',
      registrationKind: 'stateless',
      authority: 'journal',
    };

    // The narrow union inhibits assignment of a stateless registration to
    // `JournalCursorRegistration` (and vice-versa) — the kind discriminator
    // splits the union irreversibly.
    // @ts-expect-error stateless registration is not a journal-cursor registration
    const _crossAssign: JournalCursorRegistration = {
      id: 'x-1',
      kind: 'stateless',
      registrationKind: 'stateless',
    };

    expect([
      _statelessAsBase,
      _statelessAsExpansion,
      _cursorAsStateless,
      _applyAsStateless,
      _corpusAsStateless,
      _statelessWithAuthority,
      _crossAssign,
    ].length).toBe(7);
  });

  it('runtime: ConsumerDriver.register() accepts every type-valid two-axis combination', () => {
    const db = createDb();
    const driver = new ConsumerDriver({ db });
    try {
      const valid: ConsumerRegistration[] = [
        {
          id: 'cursor-base',
          authority: 'journal',
          kind: 'cursor',
          registrationKind: 'base',
        },
        {
          id: 'cursor-expansion',
          authority: 'journal',
          kind: 'cursor',
          registrationKind: 'expansion',
        },
        {
          id: 'apply-base',
          authority: 'journal',
          kind: 'apply',
          registrationKind: 'base',
          apply: async () => {},
        },
        {
          id: 'apply-expansion',
          authority: 'journal',
          kind: 'apply',
          registrationKind: 'expansion',
          apply: async () => {},
        },
        {
          id: 'corpus-base',
          authority: 'corpus',
          kind: 'apply',
          registrationKind: 'base',
          corpusInterest: 'content',
          apply: async () => {},
        },
        {
          id: 'corpus-expansion',
          authority: 'corpus',
          kind: 'apply',
          registrationKind: 'expansion',
          corpusInterest: 'metadata',
          apply: async () => {},
        },
        {
          id: 'stateless',
          kind: 'stateless',
          registrationKind: 'stateless',
        },
      ];

      for (const reg of valid) {
        const handle = driver.register(reg);
        expect(handle.id).toBe(reg.id);
        expect(handle.registrationKind).toBe(reg.registrationKind);
      }
    } finally {
      void driver.shutdown();
      db.close();
    }
  });
});
