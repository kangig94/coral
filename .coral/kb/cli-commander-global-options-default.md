# Commander Global Options Are Non-Positional by Default
Promoted: 2026-03-14 | Updated: 2026-03-14
## Rule
In Commander 14, root options are already non-positional by default, so a global flag like `--output-format json` can be placed after a subcommand without extra configuration. Do not call a nonexistent `enableGlobalOptions()` helper; add the root option normally and rely on Commander’s default parsing behavior unless the CLI explicitly enables positional options.
## Why
Plans and examples can drift toward APIs that exist in other versions or wrappers. In this repo, following that advice caused a `tsc` failure because `Command.enableGlobalOptions()` is not part of Commander 14’s type surface, even though the intended behavior was already present. The wrong fix blocks the build while adding no runtime value.
## Pattern
```ts
// Right: add the root option and rely on the default non-positional parsing.
program.addOption(
  new Option('--output-format <format>', 'Output format')
    .choices(['text', 'json'])
    .default('text'),
);
```

```ts
// Wrong: this method is not available in Commander 14.
program.enableGlobalOptions();
```
