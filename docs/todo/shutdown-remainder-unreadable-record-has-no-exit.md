# A persistently unreadable shutdown-remainder record has no exit of its own

**Status**: open. Found by a tier-1 review of `pruneShutdownRemainderRecords`
(`src/coordinator/shutdown-remainder.ts`) and its retention buckets.

## What is wrong

A record that `classifyShutdownRemainderFile` classifies `unreadable` — the read itself was refused, not a
decode failure — joins the `unreadable` bucket in `pruneShutdownRemainderRecords` regardless of age
(design-philosophy.md principle 11: a genuine unknown must not be treated as decisive). That bucket is bounded
by the same `MAX_SHUTDOWN_REMAINDER_RECORDS` (32) cap as the `known` bucket, but the two buckets do not compete
with each other. If the unreadable bucket never reaches 32 entries — the common case, since it takes 32
*other* unreadable files to displace one — a record whose read failure never resolves (a permissions error
that nothing corrects, a mount that stays degraded) sits in that bucket across every restart, ranked by
`byRetentionOrder` and never reaching the `unreadable.slice(MAX_SHUTDOWN_REMAINDER_RECORDS)` eviction. Nothing
ages it out on its own, and nothing escalates it.

## Correcting the reviewer's framing: it does not warn "for the life of the daemon"

`pruneShutdownRemainderRecords` is not on a recurring timer — `trace_path` shows its only callers are
`runLifecycleStartup` and the `start` wrapper that calls it, i.e. once per coordinator boot. The
`backendLog.warn` line in the unreadable-eviction branch fires only when a record is actually displaced past
the cap; a record that never reaches that point produces **no warning at all**, not a repeating one. What
does repeat is exposure through the read path: `scanShutdownRemainderRecords`, called directly by
`readRecentShutdownRemainder` (`src/transport/http/backend/status.ts`), re-surfaces the same filename in
`skippedUnreadableRecordNames` on every `backend status` call — a re-surfacing keyed to client polling, not to
an autonomous per-daemon loop.

## Where this leaves principle 11

The filename crossing on every status read satisfies "a refusal is visible as durable status keyed by an
actionable identity." What is missing is the other half: "every hold names what ends it." This hold's only
named exit is being outranked by 31 other unreadable records, which for an otherwise-healthy installation may
never happen — so a single stuck record can occupy a retention slot indefinitely with no signal beyond a name
in a list a client has to already be polling to see, and no command lets an operator clear it directly.

## What would settle it

- Whether a single persistently-unreadable record should carry its own expiry (an age ceiling or a bounded
  retry count) independent of bucket competition, so a lone stuck record does not require 31 siblings to force
  it out.
- Whether the CLI needs a verb to clear a specific named shutdown-remainder record. Principle 12 forbids a
  state that *waits* on an operator, not a command that exists for one who chooses to act — the two are
  different questions, and this entry is only the first.
