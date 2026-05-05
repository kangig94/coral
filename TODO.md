# TODO

## Optimization Candidates Requiring Logic Decisions

- Phase 7 is on hold: `src/discuss/persona/dpp.ts` uses dense matrix construction for DPP selection. Replacing it with a sparse or library-backed solver needs numerical tolerances and deterministic tie-breaking rules.
