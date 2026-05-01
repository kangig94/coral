/**
 * Type-level half of `tests/invariants/expansion-registration-unrepresentable.test.ts`.
 *
 * The runtime invariant uses AST grep to catch source files that declare a
 * cursor-expansion registration. This file binds the *structural* claim:
 * `JournalCursorRegistration` is not assignable to `ExpansionConsumerRegistration`,
 * and `registrationKind` is not assignable through the public boundary.
 *
 * Typechecked by `tsc -p tests/types/tsconfig.json` (run from `npm test`).
 * Vitest does not typecheck, so `@ts-expect-error` directives outside this
 * directory are dead text — keep type-level assertions here.
 */

import type { ExpansionHost } from '#src/expansion/contract.js';

declare const _host: ExpansionHost;
declare const _scope: ExpansionHost['scope'];

// The load-bearing claim of AC2.3 is that the public boundary
// `ExpansionHost.registerConsumer` rejects cursor-shaped registrations at
// compile time. Object-literal excess-property checking enforces this even
// for arguments whose declared union shape is `ExpansionConsumerRegistration`
// (`HostDerivedRegistrationKind<JournalApplyRegistration | CorpusConsumerRegistration | StatelessProviderLifecycleRegistration>`).

_host.registerConsumer(
  // @ts-expect-error host.registerConsumer rejects kind:'cursor' at the public boundary.
  { id: 'cursor-expansion', authority: 'journal', kind: 'cursor' },
  _scope,
);

// `registrationKind` is host-derived (`registrationKind?: never` in the public
// type), not accepted at the public boundary. An object literal that supplies
// it must fail to satisfy `ExpansionConsumerRegistration`.
_host.registerConsumer(
  // @ts-expect-error registrationKind is host-derived; the public boundary forbids passing it.
  { id: 'stateless', kind: 'stateless', registrationKind: 'stateless' },
  _scope,
);
