# File Dependencies Must Match the Install Layout
Promoted: 2026-03-10 | Updated: 2026-03-10
## Rule
When one project depends on another through a local `file:` path, validate that the relative path is correct in every supported install layout, not just the development checkout. If the same repository can be installed in multiple layouts, make the path context-specific at install time (or use a packaging strategy that removes the layout dependency) and verify each layout explicitly.
## Why
A local dependency like `"coral": "file:../coral"` can work perfectly in a sibling development checkout while failing in a nested plugin install where the dependent repo lives under the provider repo. The failure appears late, during `npm install` or runtime startup, because the source tree looks correct and TypeScript still compiles in the dev layout.
## Pattern
Right:
```text
Development checkout:
~/workspace/coral
~/workspace/coral-reef
package.json -> "coral": "file:../coral"

Nested plugin install:
${__PLUGIN_ROOT__}/coral-reef
install step rewrites/localizes dependency -> "coral": "file:.."

Verification:
- build/install succeeds in both layouts
```

Wrong:
```text
Assume one static file path works everywhere
-> dev checkout passes
-> nested install resolves the wrong parent and npm install fails
```
