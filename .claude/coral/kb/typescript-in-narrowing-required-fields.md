# TypeScript `in` Narrowing Produces `never` for Required Fields

## Rule
Never use `'field' in obj` to check whether a field exists on a TypeScript type where that field is required (non-optional). TypeScript narrows the false branch to `never` because the type guarantees the field is always present. Access field values on the raw `Record<string, unknown>` before casting to the typed interface.

## Why
Used in legacy-state migration functions (like `normalizeState`) where the raw JSON may be missing fields that the current TypeScript type declares as required. The cast `raw as DiscussState` followed by `if (!('last_speech_step' in state))` fails to compile: TypeScript sees `DiscussState.last_speech_step: number` as always present, narrows the missing-field branch to `never`, and flags property access inside it as an error.

## Pattern
```typescript
// WRONG — `in` check on required field narrows branch to `never`
export function normalizeState(raw: Record<string, unknown>): DiscussState {
  const state = raw as DiscussState;
  if (!('last_speech_step' in state)) {
    state.last_speech_step = 0;  // TS error: 'last_speech_step' does not exist on type 'never'
  }
}

// RIGHT — operate on raw dict before casting
export function normalizeState(raw: Record<string, unknown>): DiscussState {
  if (raw['last_speech_step'] === undefined) raw['last_speech_step'] = 0;
  if (raw['transcript'] === undefined) raw['transcript'] = [];
  // ... other field defaults ...
  return raw as unknown as DiscussState;  // cast AFTER all defaults applied
}
```

The `as unknown as TargetType` double cast is the correct idiom when asserting that a `Record<string, unknown>` has been populated to satisfy an interface — it avoids the "insufficient overlap" error from a direct single cast.
