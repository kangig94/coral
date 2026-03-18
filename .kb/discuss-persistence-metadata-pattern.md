# Persistence Metadata vs Domain State in SessionStore

## Rule
Fields that are purely persistence bookkeeping (e.g., rendering cursors, incremental write offsets) should be stripped from the TypeScript domain type and managed exclusively at the `SessionStore` boundary. Keep them in `state.json` for durability, but load them into an in-memory Map and strip them from the returned state object. Use `??` not `||` for the fallback — `0` is a valid cursor but is falsy.

## Why
Mixing persistence metadata into the domain type (`DiscussState`) conflates two concerns: the state machine operates on domain state, while the session store manages persistence bookkeeping. Having `transcript_rendered` in `DiscussState` means every state-machine test must include it, and the state machine "knows about" a rendering cursor it never uses. Moving it to `SessionStore` gives a clean separation: the type only contains what the domain logic reads.

## Pattern
```typescript
// In load(): strip persistence metadata, seed in-memory cursor
const raw = JSON.parse(fs.readFileSync(...)) as DiscussState & { transcript_rendered?: number };
this.renderCursors.set(fullPath, raw.transcript_rendered ?? raw.transcript.length);
//                                                         ^^ not || — 0 is a valid cursor, not absent
const { transcript_rendered: _tr, ...state } = raw;
return state;  // DiscussState without transcript_rendered

// In save(): re-inject cursor as persistence metadata
const cursor = this.renderCursors.get(fullPath) ?? 0;
const newEntries = state.transcript.slice(cursor);
// ... append newEntries to transcript.md ...
const toWrite = { ...state, transcript_rendered: state.transcript.length };
writeStateAtomic(statePath, toWrite);  // field present in file, absent from TS type
this.renderCursors.set(fullPath, state.transcript.length);
```

## Gotcha: `??` vs `||` for Zero Cursor
`raw.transcript_rendered ?? raw.transcript.length` correctly treats `0` as a valid cursor (not absent). Using `||` instead would treat `0` as absent and fall back to `transcript.length`, silently skipping re-render of entries that should be re-rendered. The adversarial test `'should treat transcript_rendered=0 as zero cursor'` pins this behavior.
