# TODO — give the KB daemon an enforcer outside its own process

**Status**: open. The daemon bounds cooperative teardown only while its own event loop still turns; no
independent authority guarantees that the daemon or the processes it launches disappear.

## What exists

`createKbDaemonTerminalWindowAuthority` (`src/kb-daemon/daemon-main.ts`) opens one terminal window on the
first stop request, aborts cooperative disposal partway through it, and exits at its close. That bounds the
production failure in which a SIGTERM handler ran after another stop trigger had already latched.

It does not bound a synchronously blocked daemon. `mergeBodiesWithGit`
(`src/kb/curate/frontmatter-merge-driver.ts`) reaches a timeout-bounded `execFileSync`; while that synchronous
call is blocked, the daemon cannot run its own deadline, stdin, or signal callbacks. A kernel-blocked
synchronous operation can therefore suspend the authority that is meant to enforce the window. Parent-local
escalation is not the missing guarantee either: `gracefulKill` (`src/infra/process-supervision.ts`) schedules
SIGKILL in the coordinator's event loop, so the escalation disappears if the coordinator exits first.

## What is owed

Give the KB daemon a containment enforcer that is neither the coordinator nor the daemon. The provider
guardian/reaper already demonstrate the required semantics in `createArmedEnforcer`
(`src/provider-proxy/enforcement.ts`): latch before awaited teardown, hold an absolute deadline outside the
owned process, and confirm containment absence instead of trusting leader exit.

The shared concept must have its own lower-level home. Importing
`src/provider-proxy/orphan-deadline.ts` into KB would make a provider-specific protocol the owner of generic
process lifetime; copying it would create two homes. Per-platform mechanisms such as
`prctl(PR_SET_PDEATHSIG)`, cgroups, launchd jobs, or a native addon are not an acceptable replacement for one
cross-platform containment contract.

The enforcer also has to cover descendants started through `runtime.process.exec`
(`src/runtime/exec-builder.ts`). Those children run in their own process groups with no recorded containment;
registering them only after spawn leaves an execution race. The containment authority must therefore own or
gate the spawn, not observe it afterward.

Two adjacent gaps remain part of the acceptance boundary:

- `performTeardown` (`src/coordinator/services/recovery/lifecycle.ts`) aborts finalizations and then awaits every
  commit-started promise without a bound. An external enforcer must not depend on that join returning.
- No process-level test kills a coordinator and proves the KB daemon and its detached descendants disappear.
  Unit tests that release mocked work before disposal do not exercise the guarantee.

The result may be described as KB containment only when the daemon and the children it can launch share the
same independently enforced lifetime.
