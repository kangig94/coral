# TODO — decide the lifetime of capsules whose recorded absence cannot be proved

**Status**: open for undecidable absence. Proven-absent foreign capsules already retire.

`recordedProcessesAllAbsent` in `src/coordinator/services/provider-proxy-set/index.ts` skips a V1 capsule because it records no processes. For V2 it observes pids without incarnations; a recycled pid can appear alive. V3 and V4 carry incarnations, but an observer that repeatedly returns `unknown` still cannot prove absence. The current writer uses V4 (`CURRENT_HANDOFF_CAPSULE_VERSION` in `src/provider-proxy/handoff-capsule.ts`); this entry concerns retained older capsules and persistent observation failures, not a new capsule format.

These retained capsules do not consume proxy-set admission capacity. A later boot can try observation again, but the same missing fields or persistent probe refusal may keep producing the same answer. Absence alone permits automatic retirement today; neither age nor a failed probe is absence.

## Remaining decision

Choose an unattended exit for each undecidable population, or explicitly accept bounded permanent residue. An age-based retirement would need a stated tolerance for deleting the credential of a possibly live set. An operator-clear command cannot be the required exit under principle 12. Keep `unknown` distinct from `absent` in any design.
