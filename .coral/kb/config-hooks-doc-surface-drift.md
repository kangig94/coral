# Hook Audits Must Trust `hooks/hooks.json` and Scripts Over Docs
Promoted: 2026-03-09 | Updated: 2026-03-09
## Rule
When auditing Coral's hook system, treat `hooks/hooks.json` and the concrete `hooks/*.mjs` scripts as the source of truth. The prose docs can lag behind the installed hook set, event grouping, and per-hook behavior.
## Why
Hook behavior is split across configuration and scripts, and documentation drift can create false architecture conclusions. In the current tree, the docs still mention a removed `silent-failure-detector.mjs`, describe "all 9 hooks" instead of the current event-group layout, and overstate `discuss-idle-guard.mjs` by claiming vote enforcement that the script does not implement.
## Pattern
```text
Right:
- Start from hooks/hooks.json to see which events and matchers are active
- Read the referenced hooks/*.mjs files to confirm behavior

Wrong:
- Infer the active hook set or semantics from docs/hooks.md or docs/configuration.md alone
```
