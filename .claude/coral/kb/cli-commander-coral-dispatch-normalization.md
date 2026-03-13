# Preserve `coral:<agent>` UX Through Argv Normalization
Promoted: 2026-03-13 | Updated: 2026-03-13
## Rule
When a Commander-based Coral CLI needs to support the public `codex coral:<agent>` or `claude coral:<agent>` syntax, do not try to encode the dynamic agent segment directly into the subcommand name. Define the parser as `coral <agent>` and rewrite `process.argv` before parsing so a provider invocation whose next token matches `coral:<name>` becomes `coral`, `<name>`.
## Why
Commander models dynamic segments as positional arguments, not as literal subcommand names with embedded placeholders. If the CLI exposes only `coral <agent>`, it drifts from the documented Coral command surface; if it invents a separate manual parser for `coral:<agent>`, help and validation diverge from the rest of the command tree.
## Pattern
```ts
function normalizeProviderArgv(argv: readonly string[]): string[] {
  const provider = argv[2];
  const token = argv[3];
  const match = /^coral:([a-z0-9][a-z0-9-]*)$/.exec(token);
  if (!match || (provider !== 'codex' && provider !== 'claude')) return [...argv];
  return [argv[0], argv[1], provider, 'coral', match[1], ...argv.slice(4)];
}

program.parseAsync(normalizeProviderArgv(process.argv));
```

```ts
// Wrong: forces users onto a different syntax than the plan/ACs.
provider.command('coral').argument('<agent>');
// ...without preserving `coral:<agent>` at the CLI boundary.
```
