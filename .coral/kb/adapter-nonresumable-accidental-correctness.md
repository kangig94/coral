# Adapter NonResumable Accidental Correctness
## Rule
Do not use `expr || undefined` to model an optional boolean field when `expr` is already a boolean expression; use a ternary so the code says explicitly when the field should be `true` and when it should be omitted.
## Why
`result.sessionId == null || undefined` works only by accident because JavaScript parses it as `(result.sessionId == null) || undefined`. That yields `true` when the session id is nullish and `undefined` otherwise, which happens to fit an optional `nonResumable` field, but the expression reads like a typo and hides the intended contract.
## Pattern
Right:
```javascript
nonResumable: result.sessionId == null ? true : undefined
```

Wrong:
```javascript
nonResumable: result.sessionId == null || undefined
```
