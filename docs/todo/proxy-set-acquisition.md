# TODO — provider-proxy acquisition fails on a start-time disagreement

**Status**: open. **Rewritten 2026-08-15 — the previous version of this document had the wrong cause.**
It recorded a silent-abandonment hypothesis built on the absence of a log line. A log line existed; the
earlier search simply predated it appearing.

## What was actually observed

```
WARN Provider proxy set acquisition failed for codex (…):
guardian identity disagreement on processStartedAtSeconds:
this acquisition issued 1786780788, the process reported 1786780791.
```

Three seconds apart. The check is `assertIdentityFieldsAgree`
(`src/coordinator/live/provider-proxy/role-control.ts:167-179`, comparison at `:173`): an acquisition
issues an expected identity and compares every field against what the spawned process reports; any
disagreement — `processStartedAtSeconds` included — throws and fails the acquisition.

Acquisition is therefore **attempted, logged, and failed** — not silently skipped. When it fails the
route stays absent, `routeAppServerOperation` returns `null`, and every operation takes the
`local-authorized` fallback. The coordinator keeps working without the isolation the proxy exists to
provide.

## What the previous version got wrong, and why it matters

It claimed the coordinator never attempted acquisition, reasoning from an empty log. That inference was
unsound in a specific way worth keeping: **a successful acquisition also logs nothing**, so absence of a
log distinguished nothing. The hypothesis then pointed at `already-represented` — a genuinely silent
branch, and a real reporting gap — but not at what was happening here.

Two things survive from that version and remain true:

- `ensureProxySetFor` (`src/coordinator/live/provider-hosts/index.ts:334-368`) reports only the
  `capacity` refusal (`:346-350`). Every other non-accepted admission returns silently, and so does the
  earlier `routeFor(identityKey) !== null` short-circuit at `:341`. That is still a reporting gap worth
  closing, and it is why the real cause took a second incident to surface.
- `ProviderProxySetLifecycleSnapshot` already computes `startupDiscoveryCompleted`, `represented`,
  `available` and `states` (`src/coordinator/services/provider-proxy-set/index.ts:140`, produced by
  `snapshot()` at `:577`), and has **no production consumer** — its only readers are in
  `tests/unit/coordinator/services/provider-proxy-set-lifecycle.test.ts`, a unit test, not an
  integration test as an earlier revision said. The observability this needs is already built and
  unpublished.

## The defect

A start time compared for exact equality across a spawn is not a stable identity. The acquisition issues
its expectation before the process exists; the process reports its own start afterward. Any delay
between those two moments that crosses a second boundary — a slow spawn, a loaded machine, a cold
filesystem — makes them disagree, and the acquisition fails.

This is the most plausible explanation for the machine-to-machine divergence that has been read as
environment weirdness: a fast machine acquires, a slow one does not, on the same build.

## What has to be decided

1. **What identity a spawned role actually has.** If `processStartedAtSeconds` is meant to prove
   "this is the process I spawned, not a recycled pid", then it must be _read from the process_ on both
   sides rather than _issued_ by one side and checked against the other. Compare what the acquisition
   issues against how the reaper and guardian obtain the same field.
2. **Whether disagreement should fail the acquisition at all**, or retire the attempt and retry. A
   failed acquisition currently costs the coordinator its proxy for the rest of its uptime unless
   something else triggers `ensureProxySetFor` again.
3. **Publishing the snapshot** through `backend status`, so the condition is visible without reading a
   log that has already scrolled. This is independent of 1 and 2 and can land first.

## Explicitly out of scope

This does not change the local-authorized fallback, the control protocol, the containment model, or
#308's authority-fault classification.

## Start condition

Reproduce the disagreement deliberately — delay the spawn past a second boundary and confirm the
acquisition fails — before changing the comparison. The failure has been observed but not yet produced
on demand, and this document has already been wrong once about a cause inferred rather than reproduced.
