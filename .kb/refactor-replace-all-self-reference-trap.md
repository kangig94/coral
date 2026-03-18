# Global replace can rewrite a new helper into recursion
Promoted: 2026-03-14 | Updated: 2026-03-14
## Rule
When extracting a repeated expression into a helper with search-and-replace, do not run a broad replacement after inserting the helper unless the helper body is excluded from the replacement. Write the helper first and replace only call sites, or restore the helper body immediately afterward.
## Why
A global replacement can match inside the helper you just created and turn its return expression into a call to itself. That accidental recursion survives type-checking, can be minified into an opaque stack-overflow failure, and is easy to miss during a refactor that otherwise looks mechanical.
## Pattern
Right:
```ts
function isTextOutput() {
  return program.opts<Options>().outputFormat !== 'json';
}

// Replace only the remaining call sites.
```

Wrong:
```ts
function isTextOutput() {
  return program.opts<Options>().outputFormat !== 'json';
}

replaceAll("program.opts<Options>().outputFormat !== 'json'", 'isTextOutput()');
// helper body becomes: return isTextOutput();
```
