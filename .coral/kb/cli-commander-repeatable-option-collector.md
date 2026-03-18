# Commander Repeatable Options Need an Explicit Collector
Promoted: 2026-03-14 | Updated: 2026-03-14
## Rule
When a Commander CLI option is intended to be repeatable, do not declare it with plain `.option('--flag <value>')` and then assume `opts.flag` is an array. Repeated uses overwrite the previous value unless the option supplies a collector parse function that appends into an array.
## Why
Plan and implementation work can drift here because Commander accepts the repeated syntax at parse time, but the command action only receives the last value. That silently breaks flows like `--agent ... --agent ...` or `--axis ... --axis ...`: validation and examples appear correct while earlier entries disappear before the action sees them.
## Pattern
```ts
// Right: accumulate repeated values explicitly.
command.option(
  '--agent <spec>',
  'Agent spec',
  (value: string, previous: string[] = []) => [...previous, value],
  [],
);
```

```ts
// Wrong: second use overwrites the first.
command.option('--agent <spec>', 'Agent spec');
```
