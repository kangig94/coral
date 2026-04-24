// Public read-only CoralStore surface across Journal and Corpus authority.
// Write-side primitives (appendEvents, rebuildProjections) are NOT exported here —
// coordinator code imports them directly from src/store/append.js and src/store/rebuild.js.

export { CoralStore } from './coral-store.js';
export { openStoreDatabase } from './db.js';
export { applyStoreSchemas } from './schema-loader.js';
export { journalEventEnvelopeSchema } from './envelope.js';
export type { CoralEvent, CoralEventInput } from './envelope.js';
export type { EventsRow, MetaRow } from './schema.js';
