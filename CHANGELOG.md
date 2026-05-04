# Changelog

All notable changes to Coral are documented in this file.

## Unreleased

### Changes

- `kb promote --wiki <slug>` — prepend the new note's wikilink to the target wiki's Knowledge section as part of promotion.
- `kb wiki create/update/delete/list` — full CRUD for the new wiki entry kind. `update` accepts `--understanding[-file]`, `--evidence-append[-file]`, `--knowledge-add/--knowledge-remove/--knowledge-reorder`. Removing a Knowledge link auto-removes its trailing Evidence row (Knowledge↔Evidence stay 1:1).
- `kb wake-up` — generate a session-start context packet from recent wiki updates, sized to a configurable token budget. SessionStart hook injects it automatically when the cache stamp matches the live corpus snapshot.
- Background curate drains the wiki touch-journal (LRU move-to-front for Knowledge sections). Semantic wiki mutations stay user/LLM workflow only — curate does not auto-rewrite Understanding.
