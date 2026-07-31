# Claude Subscription Authentication Status Fix

## Status

Implemented and verified on `fix/claude-subscription-auth`. Three independent
pre-implementation reviews covered authentication semantics, regression tests,
and architecture. See [Incident Relationship](#incident-relationship) for the
limit on causal claims.

## Problem

Claude.ai subscription users authenticate Claude Code without
`ANTHROPIC_API_KEY`. The sanitized output supplied for this investigation is
shaped like:

```json
{ "loggedIn": true, "authMethod": "claude.ai" }
```

Coral's Claude auth parser does not recognize `loggedIn`. It recognizes only
`authenticated`, `status`, and `auth_status`, so both `loggedIn: true` and
`loggedIn: false` become `unknown`.

The string fallback also uses positive substring matching before negative
matching. It therefore classifies `unauthenticated` as authenticated because it
contains `authenticated`, and `inactive` as authenticated because it contains
`active`.

These are confirmed authentication-status correctness bugs.

## Incident Relationship

- The `.claude/.gitignore` migration is unrelated.
- The v0.10 provider-binding work made authentication and profile routing more
  prominent, but the parser flaw itself existed in v0.9.
- At the time of this parser correction, no target stderr or target environment
  was available, so this implementation alone was not a confirmed fix for the
  original command failure.
- A subsequent bundled live reproduction established the separate runtime root
  cause: the default print transport treated a fresh conversation reference as
  `--resume` instead of `--session-id`. See
  [Claude Print-Mode New Session Regression](./claude-print-session-regression.md).

## Goals

- Recognize current Claude Code `loggedIn` boolean output.
- Preserve API-key-free Claude.ai subscription operation.
- Eliminate positive-substring collisions in legacy string statuses.
- Treat contradictory recognized fields as unknown rather than selecting one by
  arbitrary precedence.
- Preserve current preflight compatibility for unknown output.
- Add realistic, sanitized regression fixtures through both detector and
  preflight boundaries.

## Non-goals

- Changing `unknown` from fail-open to fail-closed.
- Adding typed unknown reasons or new preflight error policy.
- Making the generic detector's `authEnvVar` optional.
- Supporting or changing API-key, gateway, Bedrock, Vertex, Foundry, or OAuth
  environment-variable routing.
- Changing provider binding, execution plans, profile routing, or
  `.claude/.gitignore`.
- Adding a live Claude request to automated CI.

## Compatibility Decisions

### Unknown remains compatible

`unknown` currently combines unrecognized JSON, malformed output, unsupported
commands, timeouts, process errors, and unrelated nonzero exits. Rejecting the
entire category would be a separate compatibility and policy change.

This fix retains the existing behavior: only explicit unauthenticated evidence
is rejected by preflight.

### The generic API-key shortcut remains unchanged

The generic detector supports `authEnvVar`, but Claude's v0.10 preflight gives
the detector only profile-routing environment (`HOME` or
`CLAUDE_CONFIG_DIR`). Raw credential selectors are rejected earlier by the
binding layer. The Claude API-key shortcut is therefore unreachable on the
normal execution path and cannot explain API-key-free subscription failure.

Changing the generic detector would broaden this patch without changing the
runtime path, so it is deferred.

### `authMethod` remains metadata

This parser determines only whether the selected Claude profile reports a
logged-in state. It does not use `authMethod` to choose or route credentials.
Credential-mode policy remains in the binding and settings validation layers.

## Design

### 1. Collect recognized boolean evidence

Recognize boolean values from:

- `loggedIn`, emitted by current Claude Code
- `authenticated`, retained for compatibility

Do not use precedence. Collect all recognized evidence and return `unknown` if
the fields conflict.

### 2. Parse string statuses with normalized exact membership

Read string values from both `status` and `auth_status`. Normalize by trimming,
lowercasing, and replacing runs of whitespace or hyphens with `_`.

Retain the intended compatibility vocabulary of the existing parser without
substring matching.

Authenticated:

- `authenticated`
- `logged_in`
- `loggedin`
- `active`

Unauthenticated:

- `unauthenticated`
- `logged_out`
- `loggedout`
- `not_authenticated`
- `missing`
- `expired`
- `inactive`

Unrecognized strings add no evidence. For parseable JSON, conflicting or absent
recognized evidence returns an explicit `unknown` result so the generic
plain-text error fallback cannot reinterpret JSON contents. Multiple fields that
agree return that shared state. Non-JSON output remains eligible for the
existing plain-text fallback.

### 3. Keep existing preflight policy

- `authenticated` proceeds.
- `unauthenticated` keeps the existing login recovery error.
- `unknown` proceeds as it did before this patch.

Route-aware recovery wording is useful but not necessary to repair auth-state
parsing; it is deferred to avoid mixing message policy into the focused change.

## Implementation

1. Update `src/providers/claude/cli-detection.ts`.
   - Parse `loggedIn`.
   - Collect evidence from all supported boolean and string fields.
   - Replace substring regular expressions with normalized exact sets.
   - Resolve conflicting or absent evidence in parseable JSON to an explicit
     `unknown` result.
   - Reserve `null` for non-JSON output so the generic plain-text fallback
     remains available.
2. Update `tests/unit/providers/claude/cli-detection.test.ts`.
   - Replace synthetic-only fixtures with a compact realistic matrix.
   - Keep legacy compatibility coverage.
   - Remove the Claude test's reliance on API-key evidence when testing detector
     isolation.
   - Assert the exact `claude --version` and
     `claude auth status --json` calls for the no-key path.
3. Update `tests/unit/providers/claude/provider-facets.test.ts`.
   - Make the default successful fixture use sanitized subscription output.
   - Add a vertical no-key `loggedIn: true` preflight test.
   - Add a `loggedIn: false` rejection test.
   - Retain current settings-selector rejection coverage.
4. Do not change `src/providers/cli-detection.ts`,
   `src/providers/claude/provider-facets.ts`, binding, or execution-plan code
   unless implementation reveals a contradiction with this reviewed design.

## Test Matrix

| Auth command output, exit 0                           | Expected detector state |
| ----------------------------------------------------- | ----------------------- |
| `{"loggedIn":true,"authMethod":"claude.ai"}`          | authenticated           |
| `{"loggedIn":false}`                                  | unauthenticated         |
| `{"authenticated":true}`                              | authenticated           |
| `{"authenticated":false}`                             | unauthenticated         |
| `{"loggedIn":true,"authenticated":false}`             | unknown                 |
| `{"status":" LOGGED-IN "}`                            | authenticated           |
| `{"status":"unauthenticated"}`                        | unauthenticated         |
| `{"status":"inactive"}`                               | unauthenticated         |
| `{"status":"not-authenticated"}`                      | unauthenticated         |
| `{"auth_status":"expired"}`                           | unauthenticated         |
| conflicting recognized fields with an error token     | unknown                 |
| unknown valid JSON containing an error token          | unknown                 |
| non-JSON output without a recognized plain-text error | unknown                 |
| array, `null`, or empty JSON output                   | unknown                 |

Preflight boundary:

| Condition                                               | Expected result                              |
| ------------------------------------------------------- | -------------------------------------------- |
| No API key, `loggedIn: true`                            | success after version and auth-status probes |
| No API key, `loggedIn: false`                           | existing `claude auth login` recovery error  |
| Unknown auth result                                     | current compatibility behavior: proceed      |
| Unsupported credential selector in environment/settings | existing rejection                           |

Existing execution-plan tests remain the source of truth for default `HOME` and
explicit `CLAUDE_CONFIG_DIR` routing; this patch does not duplicate them.

## Verification

Run, in order:

```bash
npx vitest run --config vitest/default.ts \
  tests/unit/providers/claude/cli-detection.test.ts \
  tests/unit/providers/claude/provider-facets.test.ts \
  tests/unit/providers/cli-detection.test.ts

npx vitest run --config vitest/default.ts \
  tests/unit/providers/claude/provider-facets.test.ts \
  tests/unit/providers/binding-lifecycle.test.ts \
  tests/unit/providers/binding-registry.test.ts \
  tests/unit/providers/execution-plan.test.ts \
  tests/unit/runtime/binding.test.ts \
  tests/unit/expansion/require-binding-validation.test.ts \
  tests/invariants/principal-binding.test.ts \
  tests/invariants/provider-binding-ownership.test.ts

npx eslint \
  src/providers/claude/cli-detection.ts \
  tests/unit/providers/claude/cli-detection.test.ts \
  tests/unit/providers/claude/provider-facets.test.ts
npm run typecheck:tests
npx prettier --check \
  src/providers/claude/cli-detection.ts \
  tests/unit/providers/claude/cli-detection.test.ts \
  tests/unit/providers/claude/provider-facets.test.ts \
  docs/plans/claude-subscription-auth-regression.md
git diff --check
npm test
```

This parser-focused verification originally excluded the reported live command.
The later bundled reproduction and runtime fix are recorded in
[Claude Print-Mode New Session Regression](./claude-print-session-regression.md).

## Risks and Mitigations

- **A future Claude version changes schema again.** Unknown compatibility is
  retained; realistic fixtures make currently supported evidence explicit.
- **Conflicting fields appear during a transition.** They resolve to unknown
  rather than trusting arbitrary field order.
- **Exact status matching drops accidental regex compatibility.** The explicit
  sets retain the intended values from the previous positive and negative
  patterns while removing substring collisions.

## Acceptance Criteria

- A sanitized Claude.ai subscription fixture with `loggedIn: true` is reported
  authenticated without API-key evidence.
- `loggedIn: false`, `unauthenticated`, `inactive`, and `not-authenticated` are
  reported unauthenticated.
- Contradictory recognized fields are reported unknown.
- Unknown output retains current preflight compatibility.
- Raw credential-selector policy and profile routing are unchanged.
- Focused tests, provider binding/execution-plan tests, typecheck, lint,
  formatting, and the standard test suite pass.

## Implementation Outcome

Completed:

- `loggedIn` boolean output is recognized without API-key evidence.
- Legacy boolean and string output remains supported.
- Negative substring collisions are removed through exact normalized matching.
- Contradictory recognized fields resolve to unknown.
- Unknown preflight compatibility, binding policy, and execution-plan routing
  remain unchanged.

Verification snapshot recorded on 2026-07-31 against the uncommitted working
tree on `fix/claude-subscription-auth`:

- focused Claude and generic detector tests: 58 passed
- provider binding and execution-plan regression tests: 131 passed
- changed-file ESLint: passed
- TypeScript test typecheck: passed
- Prettier and `git diff --check`: passed
- repository standard test suite: 428 files and 4,147 tests passed

The parser fix remains independently valid, but it was not the cause of the
externally observed command failure. A later bundled reproduction identified
and fixed the print transport's fresh-session `--resume` bug; see
[Claude Print-Mode New Session Regression](./claude-print-session-regression.md).
