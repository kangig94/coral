# TODO — make provider-proxy acquisition identity and refusal visible

**Status**: open for the identity-check design and status reporting. The start-time defect that opened
this entry was fixed in #324.

`assertIdentityFieldsAgree` in `src/coordinator/live/provider-proxy/role-control.ts` checks the
acquisition's expected role identity against the role's self-report. `ProcessIncarnation` in
`src/infra/node-process.ts` replaced the old derived `processStartedAtSeconds`; on Linux it uses boot
identity and start ticks, so the earlier cross-process clock drift cannot recur. The remaining choice is
whether acquisition should keep comparing two independently obtained values or re-probe the connected
pid in the same way as redemption. Any disagreement must still refuse unsafe acquisition.

`ensureProxySetFor` in `src/coordinator/live/provider-hosts/index.ts` reports the capacity refusal,
but other non-accepted admissions and the existing-route short circuit are not fully visible through
`backend status`. `ProviderProxySetLifecycle.snapshot` in
`src/coordinator/services/provider-proxy-set/index.ts` has richer state than the health projection
publishes. Publish the relevant acquisition/refusal state so a failed proxy route can be diagnosed from
status without relying on a past log line.

## Corrections retained

The first version inferred that acquisition was silently skipped from an empty log. That was wrong: a
warning recorded a guardian identity disagreement, and a successful acquisition also logged nothing.
Absence of a line distinguished neither branch. The next explanation blamed a slow spawn for a
three-second difference; later samples reached many minutes. The cause was a cross-process comparison
using a cached boot-time-derived clock, not spawn latency. The old primitive and its cache were removed
by #324.

The earlier account also treated the guardian as the recorder whose observation the reaper compared.
In fact the guardian forwarded its token to the reaper, which compared it with a fresh probe in
`src/provider-proxy/reaper.ts`; that was another cross-process comparison. A lost leader identity also
does not prove group absence: `observeContainment` in `src/infra/process-containment.ts` can answer
`recorded-group-unattributable`, which authorizes no signal or disappearance receipt. The independent
guardian/proxy comparison in `src/coordinator/live/provider-proxy/control-redemption.ts` is an intended
cross-check once its values are sound; calling the comparison itself defective was another wrong claim.

A failed lease does not cost the proxy for the rest of uptime. `acquireHostLease` in
`src/coordinator/live/provider-hosts/index.ts` calls `ensureProxySetFor` on each acquisition.
The old item asking whether the first failed attempt should retry forever therefore had a false
premise and is withdrawn.

## Start condition

Read `assertIdentityFieldsAgree` with the probes in
`src/coordinator/live/provider-proxy/acquisition-steps.ts` and `src/provider-proxy/role-main.ts`.
Decide whether to retain the independent cross-check or re-probe the connected pid; independently
publish the refusal and snapshot state through `backend status`. The historic clock-drift failure is
not a reproduction target.
