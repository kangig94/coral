// Public read-only surface for the Journal.
// Write-side primitives (appendEvents, rebuildProjections) are NOT exported here —
// coordinator code imports them directly from src/store/append.js and src/store/rebuild.js.

export { CoralStore } from './coral-store.js';
export { openStoreDatabase } from './db.js';
export { applyMigrations } from './migrations.js';
export { journalEventEnvelopeSchema } from './envelope.js';
export type { CoralEvent, CoralEventInput } from './envelope.js';
export type { EventsRow, MetaRow, CorpusStateRow, CurateSchedulerRow } from './schema.js';
