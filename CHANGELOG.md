# Changelog

All notable changes to Coral are documented in this file.

## Unreleased

### Changes

- `kb promote --wiki <slug>` — prepend the new note's wikilink to the target wiki's Knowledge section as part of promotion.
- `kb wiki create/update/delete/list` — full CRUD for the new wiki entry kind, including reordering and Knowledge-section maintenance flags.
- `kb wake-up` — generate a session-start context packet from recent wiki updates, sized to a configurable token budget.
- Background curate now drains the wiki touch-journal (LRU move-to-front for Knowledge sections) and maintains Understanding sections from newly imported sources.
