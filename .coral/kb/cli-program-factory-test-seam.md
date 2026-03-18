# Commander CLIs Need a Program Factory for Wiring Tests
Promoted: 2026-03-15 | Updated: 2026-03-15
## Rule
If a Commander-based CLI calls `program.parseAsync(...)` at module import time, split command construction from bootstrap before promising unit coverage for command wiring. Export a `buildProgram()`-style factory or equivalent action-registration seam so tests can inspect or invoke command handlers without triggering parse side effects, and keep spawn-based smoke tests for help, validation, and non-TTY behavior only. When a command now follows jobs by default, validation-only smoke tests should opt into `--detach` so they stay on the old one-shot path instead of drifting into backend/wait behavior.
## Why
Import-time parsing traps handlers behind side effects and makes default-path wiring hard to test without brittle child-process orchestration. In Coral, that interacts badly with `spawnSync`'s pipe-backed stdio: the smoke harness is useful for help and validation, but it cannot prove TTY-only branches or fine-grained `--detach` versus default-follow action selection. After the default-wait rollout, old workflow validation tests that kept using the bare command started exercising launch-and-follow instead of stopping after argument parsing, which made them hang or become timing-sensitive for the wrong reason.
## Pattern
Right:
```typescript
export function buildProgram(): Command {
  const program = new Command();
  registerCommands(program);
  return program;
}

export async function runCli(argv: readonly string[]): Promise<void> {
  await buildProgram().parseAsync(argv);
}
```

```typescript
const program = buildProgram();
await program.parseAsync(['node', 'coral-cli', 'codex', 'exec', '--detach', '--prompt', 'hi']);
```

```typescript
// Bundle smoke test: stay on the validation path by opting out of default follow.
spawnSync('node', [CLI_BUNDLE, 'workflow', '--input-json', '-', '--detach'], {
  input: JSON.stringify({ expression: '(architect)', init_prompt: 'hi' }),
});
```

Wrong:
```typescript
const program = new Command();
registerCommands(program);
program.parseAsync(process.argv);
```
