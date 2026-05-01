/**
 * Type-level half of `tests/invariants/consumer-registration-axes.test.ts`.
 *
 * Each `@ts-expect-error` block below MUST fail at compile time. If the
 * compiler stops rejecting any of these, the structural invariant is broken
 * and future drift can pair (e.g.) `kind: 'stateless'` with
 * `registrationKind: 'base'` without a build error.
 *
 * Typechecked by `tsc -p tests/types/tsconfig.json` (run from `npm test`)
 * and by `tsc -p tsconfig.test.json --noEmit` (the broader gate).
 */

import type {
  CorpusConsumerRegistration,
  JournalApplyRegistration,
  JournalCursorRegistration,
  StatelessProviderLifecycleRegistration,
} from '#src/store/consumer-contract.js';

// Stateless kind paired with non-stateless registrationKind:
const _statelessAsBase: StatelessProviderLifecycleRegistration = {
  id: 's-1',
  kind: 'stateless',
  // @ts-expect-error stateless kind requires registrationKind: 'stateless'
  registrationKind: 'base',
};
const _statelessAsExpansion: StatelessProviderLifecycleRegistration = {
  id: 's-2',
  kind: 'stateless',
  // @ts-expect-error stateless kind requires registrationKind: 'stateless'
  registrationKind: 'expansion',
};

// Non-stateless kind paired with registrationKind: 'stateless':
const _cursorAsStateless: JournalCursorRegistration = {
  id: 'c-1',
  authority: 'journal',
  kind: 'cursor',
  // @ts-expect-error journal-cursor cannot pair with registrationKind: 'stateless'
  registrationKind: 'stateless',
};
const _applyAsStateless: JournalApplyRegistration = {
  id: 'a-1',
  authority: 'journal',
  kind: 'apply',
  // @ts-expect-error journal-apply cannot pair with registrationKind: 'stateless'
  registrationKind: 'stateless',
  apply: async () => {},
};
const _corpusAsStateless: CorpusConsumerRegistration = {
  id: 'co-1',
  authority: 'corpus',
  kind: 'apply',
  // @ts-expect-error corpus-apply cannot pair with registrationKind: 'stateless'
  registrationKind: 'stateless',
  corpusInterest: 'content',
  apply: async () => {},
};

// Stateless arm must not declare `authority` (the type pins it to `never` for
// that arm). Adding the field is a compile error.
const _statelessWithAuthority: StatelessProviderLifecycleRegistration = {
  id: 's-3',
  kind: 'stateless',
  registrationKind: 'stateless',
  // @ts-expect-error stateless arm has authority?: never
  authority: 'journal',
};

// The narrow union inhibits assignment of a stateless registration to
// `JournalCursorRegistration` (and vice-versa) — the kind discriminator splits
// the union irreversibly.
const _crossAssign: JournalCursorRegistration = {
  id: 'x-1',
  // @ts-expect-error stateless registration is not a journal-cursor registration
  kind: 'stateless',
  // @ts-expect-error stateless registrationKind cannot pair with kind: 'cursor'
  registrationKind: 'stateless',
};

// Suppress unused-binding warnings without a runtime test.
export type _CompileTimeOnly = [
  typeof _statelessAsBase,
  typeof _statelessAsExpansion,
  typeof _cursorAsStateless,
  typeof _applyAsStateless,
  typeof _corpusAsStateless,
  typeof _statelessWithAuthority,
  typeof _crossAssign,
];
