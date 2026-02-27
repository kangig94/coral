# TypeScript `Extract` Collapses to `never` When Union Member Has a Union-Typed Field

## Rule
When a discriminated union member uses a union literal for a secondary field (e.g., `event: 'force_end' | 'synthesis'`), `Extract<Union, { event: 'synthesis' }>` resolves to `never` because no single member has exactly `event: 'synthesis'`. Use an intersection instead: `Extract<Union, { type: 'session_event' }> & { event: 'synthesis' }`.

## Why
TypeScript's `Extract` matches by subtype assignability — it looks for union members where the whole member type is assignable to the constraint. A member with `event: 'force_end' | 'synthesis'` is not assignable to `{ event: 'synthesis' }` (the union is wider), so `Extract` returns `never`. Downstream type predicates and property accesses then fail with `Property 'detail' does not exist on type 'never'` at compile time.

## Pattern
```typescript
// Source type — event field is a union, not a single literal
type TranscriptEntry =
  | { type: 'bids'; ... }
  | { type: 'session_event'; event: 'force_end' | 'synthesis'; detail: string; ... };

// WRONG — Extract collapses to never because no member has exactly event: 'synthesis'
type SynthesisEntry = Extract<TranscriptEntry, { event: 'synthesis' }>;  // → never
// Property access on never errors at compile time

// RIGHT — Extract on the type discriminant, then intersect with the event narrowing
type SynthesisEntry = Extract<TranscriptEntry, { type: 'session_event' }> & { event: 'synthesis' };
// → { type: 'session_event'; event: 'synthesis'; detail: string; ... } ✓

// Type predicate using the correct alias
function isSynthesis(e: TranscriptEntry): e is SynthesisEntry {
  return e.type === 'session_event' && e.event === 'synthesis';
}
```
