# Transcript Rendering Is Timezone-Dependent

## Rule
`transcript.ts` formats timestamps with `new Date(ts).getHours()/getMinutes()/getSeconds()` (local wall-clock time), so the same `state.json` renders different clock times on machines in different timezones. Tests pass because they run in one timezone, but cross-host reproducibility and deterministic snapshot tests are silently broken.

## Why
Pure rendering paths are expected to be deterministic given the same input. Timezone-local formatting breaks this guarantee, and the bug is invisible in CI unless tests are run in multiple timezones.

## Pattern
```typescript
// Wrong: local timezone
new Date(ts).getHours()       // varies by machine

// Right: explicit UTC
new Date(ts).getUTCHours()    // deterministic everywhere
```
Any future changes to timestamp rendering in `transcript.ts` should use UTC methods or an injected timezone policy.
