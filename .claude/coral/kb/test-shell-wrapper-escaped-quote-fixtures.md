# Shell Wrapper Test Fixtures Need Escaped Inner Quotes

## Rule
When testing shell-wrapper parsing for commands wrapped like `bash -lc "..."`, represent inner quoted arguments with escaped quotes in the JavaScript fixture (`\\"`) so the runtime string remains syntactically valid shell input.

## Why
If inner quotes are not escaped in the fixture, the runtime command becomes malformed (for example: `bash -lc "rg "needle" src"`). The wrapper regex will correctly reject it, but the test appears to indicate a parser bug. This creates false negatives and wastes debugging time.

## Pattern
```ts
// Wrong: runtime string is malformed wrapper input
stripShellWrapper('bash -lc "rg "needle" src"');

// Right: runtime string preserves escaped inner quotes
stripShellWrapper('bash -lc "rg \\"needle\\" src"');
// => 'rg "needle" src'
```
