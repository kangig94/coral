# Event-Sourcing Refactor Leaves Dead Helpers
Promoted: 2026-03-18 | Updated: 2026-03-18
## Rule
When refactoring a module from direct state mutation to event-based decisions (decide* functions return events instead of state), check for orphaned private helper functions that previously built state directly. These helpers are typically called only by each other, never by the new event-producing functions, and silently become dead code.
## Why
In the discuss state-machine refactor, four private functions (`makeBidEntry`, `startSpeaking`, `noWinnerResult`, `buildSpeechState`) were left behind. They had internal cross-references (A calls B) that made them appear "used" to casual inspection, but no exported function called any of them. The reducer held the authoritative versions. This dead code persisted through multiple releases until a full-codebase audit caught it.
## Pattern
Right: After converting to event-based, grep for each private helper — verify at least one exported function (directly or transitively) calls it. If no exported function reaches it, it's dead.

Wrong: Assume that because a private function is called by another private function in the same file, it's still in use.
