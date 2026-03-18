# Statusline Discriminated Error State Alignment
## Rule
When a statusline section sometimes returns structured data and sometimes returns an error-only state, make that contract explicitly discriminated and branch on it before any alignment or column-derivation logic runs.
## Why
If an error sentinel is merely "truthy", upstream layout code can still derive model names, aligned columns, or secondary segments from fields that do not exist in the error case. In `coral-hud`, that would let a Codex error-only state affect `addonTier`, `codexModel`, column alignment, or spark formatting before line 2 is assembled.
## Pattern
Right:
```javascript
switch (codexData.kind) {
  case "data":
    // derive columns and spark from real payload only
    break;
  case "error":
    // render line 2 message only; line 1 alignment unchanged
    break;
  case "none":
    // silent path
    break;
}
```

Wrong:
```javascript
if (codexData) {
  const codexModel = deriveModel(codexData);
  const spark = formatSpark(codexData.spark);
  if (codexData.errorMsg) return codexData.errorMsg;
}
```
