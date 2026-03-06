# Shared-Contract Migrations Need Add -> Switch -> Delete Phase Ordering

## Rule
When a plan requires `tsc --noEmit` or similar compile gates after each phase, any migration of shared types, shared modules, or widely imported contracts must be phased as add -> switch -> delete. First add the new contract alongside the old one, then switch all consumers, then delete the old contract. Do not replace or delete the shared surface before its importers have moved.

## Why
If a phase replaces `src/types.ts`, `src/providers/types.ts`, or other shared modules before the untouched consumers switch, the compile gate becomes structurally impossible rather than merely risky. Existing imports fail even if the eventual end state is correct. The plan then appears "verified per phase" on paper while the stated checkpoint cannot pass in reality.

## Pattern
**Wrong**:
```text
Phase 1: replace shared types
Phase 2: migrate first consumer group
Phase 3: migrate remaining consumers
Verify after each phase: tsc --noEmit
```

**Right**:
```text
Phase 1: add new shared types alongside old exports
Phase 2: switch consumer group A
Phase 3: switch consumer group B
Phase 4: delete old shared types
Verify after each phase: tsc --noEmit
```
