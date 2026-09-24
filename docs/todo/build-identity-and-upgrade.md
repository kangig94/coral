# TODO — enforce additive durable records during an upgrade

**Status**: open. Principle 10 settles the policy: a durable record keeps existing fields and meanings,
adds only optional fields, and tolerates unknown keys. A shape that cannot do so needs a new generation at
a new address. This entry asks for enforcement of that rule at the mixed-build boundary.

An installed plugin swaps CLI and skill files while its existing coordinator may keep serving an older
build. A newer writer can therefore leave a record for an older reader. Quarantine prevents destruction
when that reader cannot decode a row, but it can leave a job stalled. The reader and writer must be
checked together when a durable shape changes, with an invariant or mixed-build contract test that fails
on removing, renaming, retyping, or newly requiring a field under the same address. No such cross-build
gate currently protects all durable records.

## Corrections retained

The 2026-08-15 `recovery_parse_failed` incident was first attributed to version skew. That was wrong:
`readCodexPersistedContinuity` produced a `turnId` key with `undefined` in a single build, and
`jsonValueSchema.parse` rejected it. The producer was fixed in #318; unreadable recovery records were
quarantined in #316. A visible build difference did not establish the incident's cause.

The takeover was also declared complete too early. `verifiedIncumbentFromDiscovery` in
`src/coordinator/lifecycle.ts` still compared the incumbent's namespace with the contender's, although
plugin roots change by version. That comparison discarded the incumbent's `bootToken`. The comparison is
gone; the fix landed in PR #386 (issue #385), and installed-to-installed takeover was observed on
2026-09-24. `routeLiveIncumbent` in `src/coordinator/handoff-routing/policy.ts` keeps the routing basis.

The output direction was settled as a deliberate non-goal in principle 10. Its remaining constraint is
that a stale skill must not silently misread a CLI value whose meaning changed; the `wait` case belongs
to [`cli-machine-channel.md`](./cli-machine-channel.md).

## Start condition

Inventory durable record schemas and their shipped readers, then add a check that pins additive changes
and tests a newer writer against an older reader. The jobs read contracts and result artifact availability
are consumers of the same rule; see [`jobs-read-contract-schema-first.md`](./jobs-read-contract-schema-first.md)
and [`result-artifact-availability.md`](./result-artifact-availability.md).
