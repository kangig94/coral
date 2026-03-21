# Discuss Source-Registry Tests Must Use the Shared Path Contract
Promoted: 2026-03-21 | Updated: 2026-03-21
## Rule
When discuss persistence migrates from checkout-root identity to canonical source identity, tests must seed the durable registry through the same shared path helpers the runtime uses. Write `~/.coral/discuss-sources.json` via `discussSourcesPath()` (or its alias) with a `sources` array, not the legacy `~/.claude/coral/discuss-project-roots.json` path or `projectRoots` payload.
## Why
If a fixture still writes the legacy registry location or schema, startup recovery coverage silently exercises an obsolete contract. The runtime now enumerates canonical sources from the home-scoped source registry, so a test can appear to cover recovery while actually bypassing the new discovery path and leaving the migration unverified.
## Pattern
Right:
```ts
writeFileSync(discussSourcesPath(), JSON.stringify({
  updatedAt: '2026-03-21T00:00:00.000Z',
  sources: ['local/project'],
}, null, 2));
```

Wrong:
```ts
writeFileSync(join(home, '.claude', 'coral', 'discuss-project-roots.json'), JSON.stringify({
  updatedAt: '2026-03-21T00:00:00.000Z',
  projectRoots: ['/tmp/project'],
}, null, 2));
```
