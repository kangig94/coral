# Child Coordinator Handoff and Codex Recovery Hook Guard

## Status

Implemented and verified on `fix/child-handoff-recovery-hooks`. All gates below
pass locally, including 428 files / 4,176 tests, the two-bundle lifecycle E2E,
the real Codex 0.146.0 recovery-hook probe, and a built-bundle Codex subscription
smoke with API-key variables absent. The final seven-role read-only tier
re-review reports zero unresolved BLOCKING, STRONG, MINOR, or NIT findings.

## Problem

Two independent regressions can combine during a nested `coral-cli` invocation.

### A child CLI can replace its parent before RPC authorization

Provider jobs receive a child principal whose capabilities intentionally omit
`jobs:control`. A nested `coral-cli codex ...` request should reconnect to its
parent coordinator and then be accepted or rejected by normal child-principal
authorization.

Before this change, the CLI called `ensure()` before sending child
authentication. `ensure()` compared the invoking CLI bundle with the live
coordinator and, on a mismatch, used operator authority from discovery to drain
the incumbent and spawn a replacement. A child running another Coral bundle
could therefore interrupt its parent before the parent evaluated the child RPC.

This is a lifecycle-authority bug. The child capability set and catalog
authorization rules remain the authority for the requested operation.

### Codex recovery hooks can miss the child marker

Normal Codex thread requests set `CORAL_CHILD=1` through
`shell_environment_policy`. Codex CLI 0.146.0 does not apply that thread policy
to a `SessionStart(source=resume)` hook subprocess; the hook inherits the shared
`codex app-server` process environment.

Since Coral v0.10, the exact shared-host environment omitted the marker.
Interrupted recovery also resumed the thread with an empty config. A recovery
hook could consequently run without `CORAL_CHILD=1`, and its resumed-thread
subprocesses had no explicit child marker either.

The hook system itself is not the bug. Coral-owned hook scripts already return
early when they see the marker. Codex hook dispatch, third-party hooks, MCP
servers, plugins, and skills should remain enabled.

## Incident boundary

The reported incident occurred outside this checkout, and its original logs and
provider artifacts are unavailable. The code proves that the following sequence
was possible, but this change does not claim it was the unique external cause:

1. A parent coordinator runs bundle A.
2. Its Codex child invokes a `coral-cli` from bundle B.
3. Child-side `ensure()` drains A before child RPC authorization.
4. Interrupted Codex recovery resumes a thread through a host without the child
   marker.
5. Coral's wildcard `SessionStart` hook does not take its child early-exit path
   and can attempt backend startup during recovery.

The exact cause of an external `InterruptedRecoveryBlockedError` still requires
artifacts from the affected host.

## Goals and non-goals

Goals:

- make coordinator lifecycle read-only for every child-shaped CLI environment;
- reconnect a child to its exact parent even when CLI and coordinator bundles
  differ;
- preserve child-principal authorization for the nested command itself;
- give nested failures an actionable top-level recovery path;
- keep `CORAL_CHILD=1` in the stable Codex host and in recovery thread policy;
- preserve top-level compatibility handoff; and
- verify both the Coral lifecycle boundary and the real Codex hook contract.

Non-goals:

- disabling Codex or Claude hooks, third-party hooks, MCP, plugins, or skills;
- changing Coral hook manifests or their existing child early-exit guard;
- granting child principals more capabilities;
- persisting a child-principal handle across coordinator replacement;
- changing interrupted-recovery fence/commit policy or error serialization;
- changing Claude execution; or
- treating an environment marker as a sandbox against a process that
  deliberately rewrites its own environment.

## Required invariants

### 1. Child lifecycle confinement

An invocation is child-shaped when `CORAL_CHILD=1` or any non-empty child
binding value is present: `CORAL_CHILD_PRINCIPAL_HANDLE`, `CORAL_JOB_ID`, or
`CORAL_SESSION_ID`. Partial bindings fail closed. Empty exports retain the
existing unset semantics.

A child-shaped `ensure()` may probe the fixed coordinator socket and reuse the
observed parent, but must never:

- request incumbent shutdown;
- wait for socket release in preparation for replacement;
- spawn `coral-backend`;
- clear a startup sentinel; or
- rotate or create coordinator logs for a spawn attempt.

Explicit `backend shutdown` and lazy KB restart reject a child before reading
operator credentials or issuing lifecycle requests.

### 2. Existing-parent reuse is exact and compatibility-independent

The child credential exists only in the parent coordinator's in-memory
registry. A child therefore ignores caller/coordinator bundle compatibility and
targets only the incumbent first observed at its coordinator socket.

If the parent is still starting or discovery is not yet published, the child
uses a separate read-only readiness loop. The loop pins:

- fixed socket path;
- instance ID, version, bundle hash, flavor, and namespace; and
- PID and process start time when both observations provide them.

An unreachable or draining parent, identity replacement, stale discovery, or
timeout returns a bounded error. The child never follows the replacement.

### 3. Reuse does not grant operator authority

The child-safe ensured client has no default boot auth and exposes no token
property. Each nested request continues to use nonce-bearing child-principal
metadata. An incomplete child binding raises a structured
`child_credentials_incomplete` error before dispatching an RPC.

A valid child that requests an unavailable capability receives a nested-session
message directing the operator to run the command from the top-level Coral
session.

### 4. Top-level handoff is unchanged

Without a child-shaped environment, `ensure()` retains the compatibility state
machine: reuse a compatible incumbent, drain an incompatible incumbent, and
spawn when no coordinator is reachable.

### 5. Codex marker is stable; credentials are turn-scoped

`CORAL_CHILD=1` is non-secret and belongs in the stable shared Codex host.
`CORAL_CHILD_PRINCIPAL_HANDLE`, job ID, and session ID must not enter that host
environment or fingerprint.

Normal and recovery thread configuration also pins the marker after any caller
values. Recovery supplies only the marker; it does not fabricate or reuse a
child-principal handle.

For current Codex, `SessionStart(source=resume)` hooks inherit the stable host
marker, not the resumed thread's shell policy. Coral-owned hooks consequently
return early. Hook dispatch and unrelated hook integrations remain active.

## Implementation

### Child detection and request authentication

`src/security/child-principal-env.ts` owns the complete/partial child predicate.
The IPC auth parser, lifecycle entrypoints, and HTTP shutdown path share it.

`childPrincipalAuthOptions()` converts a captured auth provider into request
options and turns an incomplete binding into a public structured error. Main
dispatch validates that binding before KB reconciliation or coordinator ensure;
follow and expansion paths use the same conversion helper. Expansion commands
construct their activation inside the command's JSON error boundary, preserving
incomplete credentials and coordinator capability denials as typed
`InstallError` responses instead of stderr or `unknown_error` fallbacks.

### Existing-only lifecycle branch

`ensure()` performs the unauthenticated health probe, then routes child-shaped
invocations to an existing-only branch before computing desired bundle identity.
That branch uses the pinned read-only readiness loop and creates an IPC client
without boot authentication.

Top-level reuse, handoff preparation, and spawn are split into separate helpers
so the child branch cannot fall through into lifecycle mutation.

`shutdownBackend()` and `shutdownAndAwaitRelease()` independently reject child
invocations. The latter protects the lazy KB restart path even if call ordering
changes later.

### Codex host and recovery configuration

`buildCodexHost()` adds a protected host-lifetime environment layer containing
only `CORAL_CHILD=1`. `codexChildShellEnvironmentPolicy()` pins the same marker
after caller values without mutating them. Normal thread start/resume and the
interrupted-recovery `thread/resume` request share that policy builder.

### User-facing failures

- incomplete bindings identify the nested command, state that no request was
  sent, and direct the user back to the top-level session;
- expansion commands retain that guidance as a single JSON response and use
  permission exit code 77 for incomplete credentials or missing capabilities;
- child lifecycle failures say that no coordinator was started or replaced and
  suggest top-level `coral-cli backend status` before retry; and
- explicit child shutdown says to run `coral-cli backend shutdown` from the
  top-level session.

## Verification matrix

### Coordinator and authorization

| Case                                                | Required evidence                                                              |
| --------------------------------------------------- | ------------------------------------------------------------------------------ |
| Top-level compatible/mismatched/absent              | existing unit suite proves reuse, handoff, and spawn                           |
| Complete child + mismatched ready parent            | reuse without boot auth, shutdown, release probe, or spawn                     |
| Marker-only or partial binding                      | shared predicate classifies it as child; incomplete auth fails before dispatch |
| Child + unreachable/draining parent                 | actionable bounded error; no lifecycle mutation                                |
| Starting parent becomes ready                       | same instance/PID/start time succeeds without operator auth                    |
| Parent PID, start time, instance, or socket changes | fail closed and do not follow replacement                                      |
| Startup sentinel during child wait                  | sentinel remains untouched                                                     |
| Child explicit shutdown/lazy restart                | denied before discovery/HTTP/release probing                                   |
| Valid registered child over capability              | server returns nested top-level-session guidance                               |
| Built bundle A parent + bundle B child              | A's PID, instance, discovery, hash, and log inode remain stable                |

### Codex boundaries

| Boundary                                          | Required evidence                                                                          |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Shared app-server host                            | marker present; handle/job/session absent                                                  |
| Normal start/resume policy                        | marker plus turn-scoped session/handle values                                              |
| Interrupted-recovery resume                       | marker only in request config                                                              |
| Real resume hook, thread policy only              | negative control records no marker                                                         |
| Real resume hook, production-shaped host + policy | probe records marker and no child credentials; production mapping units cover the builders |

The real-Codex probe is isolated from user state, self-cleaning, and
credential-free. It uses an allowlisted process environment, isolated `HOME`,
`CODEX_HOME`, and temp directories, file-only auth storage, read-only
sandboxing, an explicitly hash-trusted local hook, a Codex version gate,
bounded RPCs, and TERM/KILL cleanup. It does not inherit API keys, OS-keyring
credentials, or the user's Codex login. The probe starts a first turn to ensure
the resume hook is dispatched; it does not claim whether dispatch was scheduled
by `thread/resume` or `turn/start`. No authenticated model call is available in
the fixture.

## Verification

Focused behavior:

```bash
npx vitest run --config vitest/default.ts \
  tests/unit/transport/ipc/child-principal-auth.test.ts \
  tests/unit/transport/ipc/ensure.test.ts \
  tests/unit/transport/http/backend-shutdown.test.ts \
  tests/unit/cli/dispatch.test.ts \
  tests/unit/cli/errors.test.ts \
  tests/unit/cli/emit.test.ts \
  tests/unit/cli/expansion-help.test.ts \
  tests/unit/cli/follow.test.ts \
  tests/unit/cli/main-routing.test.ts \
  tests/unit/expansion/activate.test.ts \
  tests/unit/expansion/errors.test.ts \
  tests/unit/providers/execution-plan.test.ts \
  tests/unit/providers/codex/provider-facets.test.ts \
  tests/unit/hooks/backend-warm-start.test.ts
npx vitest run --config vitest/integration.ts \
  tests/integration/transport/ipc/server.test.ts \
  tests/integration/transport/ipc/client.test.ts \
  tests/integration/transport/ipc/subscription-primitive.test.ts
```

Static checks and full regression:

```bash
npm run typecheck:tests
npx tsc --noEmit -p tsconfig.json
npm run lint
npm run format:check
npx prettier --check \
  docs/plans/child-coordinator-handoff-and-codex-recovery-hooks.md \
  scripts/verify-codex-recovery-hook-env.mjs
git diff --check
npm test
```

Build and mandatory isolated acceptance:

```bash
npm run build:dev
npx vitest run --config vitest/e2e-lifecycle.ts \
  tests/e2e/cli/lifecycle/child-no-handoff.test.ts
node scripts/verify-codex-recovery-hook-env.mjs
```

The final subscription smoke uses the built bundle, the existing authenticated
Codex subscription profile, isolated Coral state, and explicitly absent API-key
variables:

```bash
CORAL_SMOKE_REPO="$PWD"
CORAL_SMOKE_ROOT="$(mktemp -d /tmp/coral-built-codex-XXXXXXXX)"
CORAL_SMOKE_HOME="$CORAL_SMOKE_ROOT/home"
CORAL_SMOKE_TMP="$CORAL_SMOKE_ROOT/tmp"
CORAL_SMOKE_WORK="$CORAL_SMOKE_ROOT/work"
CORAL_SMOKE_CODEX_HOME="${CODEX_HOME:-${HOME}/.codex}"

coral_smoke_cleanup() {
  CORAL_SMOKE_STATUS=$?
  CORAL_SMOKE_CLEANUP_STATUS=0
  trap - EXIT INT TERM
  set +e
  env -u OPENAI_API_KEY -u CODEX_API_KEY -u AZURE_OPENAI_API_KEY \
    -u CLAUDE_CONFIG_DIR -u CORAL_CHILD \
    -u CORAL_CHILD_PRINCIPAL_HANDLE -u CORAL_JOB_ID -u CORAL_SESSION_ID \
    HOME="$CORAL_SMOKE_HOME" TMPDIR="$CORAL_SMOKE_TMP" \
    CODEX_HOME="$CORAL_SMOKE_CODEX_HOME" \
    node "$CORAL_SMOKE_REPO/clients/build/coral-cli.cjs" \
    backend shutdown >/dev/null 2>&1
  if [ $? -ne 0 ]; then CORAL_SMOKE_CLEANUP_STATUS=1; fi
  node -e 'const fs = require("node:fs"); const p = process.argv[1]; if (!/^\/tmp\/coral-built-codex-[^/]+$/.test(p)) throw new Error("unsafe cleanup target"); fs.rmSync(p, { recursive: true, force: true });' \
    "$CORAL_SMOKE_ROOT"
  if [ $? -ne 0 ]; then CORAL_SMOKE_CLEANUP_STATUS=1; fi
  if [ "$CORAL_SMOKE_STATUS" -ne 0 ]; then exit "$CORAL_SMOKE_STATUS"; fi
  exit "$CORAL_SMOKE_CLEANUP_STATUS"
}
trap coral_smoke_cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
set -e
mkdir -p "$CORAL_SMOKE_HOME" "$CORAL_SMOKE_TMP" "$CORAL_SMOKE_WORK"

env -u OPENAI_API_KEY -u CODEX_API_KEY -u AZURE_OPENAI_API_KEY \
  -u CLAUDE_CONFIG_DIR -u CORAL_CHILD \
  -u CORAL_CHILD_PRINCIPAL_HANDLE -u CORAL_JOB_ID -u CORAL_SESSION_ID \
  HOME="$CORAL_SMOKE_HOME" TMPDIR="$CORAL_SMOKE_TMP" \
  CODEX_HOME="$CORAL_SMOKE_CODEX_HOME" \
  node "$CORAL_SMOKE_REPO/clients/build/coral-cli.cjs" \
  codex -i "hello" --work-dir "$CORAL_SMOKE_WORK"
```

Only the fixture coordinator may be shut down. The smoke succeeds only when the
`hello` job completes through subscription authentication with the recognized
API-key variables absent. The exit trap stops that fixture coordinator and
deletes only the validated `mktemp` root.

## Review gates

The pre-implementation reviews required the mutation-free readiness loop,
fixed-incumbent correlation, explicit auth modes, explicit shutdown guards, a
two-bundle E2E, and a real Codex hook probe.

The tier review then required:

- removing ambient credentials and unrestricted sandboxing from the probe;
- robust process/timer cleanup, a version gate, and a negative control;
- PID/start-time/socket and positive readiness coverage;
- smaller lifecycle helpers and shared identity/auth conversions;
- actionable nested-session errors;
- exact verification commands and honest hook-contract wording; and
- removal of flaky log-size and unnecessary implementation-detail assertions.

Every valid finding must be implemented and affected checks rerun. A read-only
tier re-review must report no unresolved BLOCKING or STRONG finding before PR
creation.

## Acceptance criteria

- No child-shaped automatic or explicit path can shut down, replace, or spawn a
  coordinator.
- A mismatched child reuses only its exact live parent and carries no implicit
  operator credential.
- Parent replacement, stale discovery, draining/unreachable state, and timeout
  fail closed with top-level recovery guidance.
- Partial child bindings fail before the nested request is sent.
- Valid child-principal capability denial remains authoritative and actionable.
- Top-level handoff behavior remains intact.
- The Codex shared host contains only the stable marker from the child-authority
  family; recovery config contains the marker and no credentials.
- Current Codex proves that resume hooks inherit the stable marker and that
  thread policy alone is insufficient.
- Focused tests, static checks, full tests, build, bundled E2E, real-Codex probe,
  tier re-review, and API-key-free built subscription smoke all pass.
