# Cache Non-Finite Timestamp Poisoning
## Rule
When cache freshness depends on `Date.now() - cache.ts`, normalize timestamps with `Number.isFinite` rather than `typeof value === "number"`. JSON numeric literals like `1e309` parse to `Infinity`, and `Infinity` can silently convert an expired entry into one that never expires.
## Why
Negative-cache designs often suppress work while an error entry is still fresh. If a malformed cache file carries `ts: Infinity`, age checks become `-Infinity`, expiry never triggers, and callers can stay permanently suppressed with no retry path.
## Pattern
Right:
```javascript
function normalizeTs(rawTs) {
  return Number.isFinite(rawTs) ? rawTs : 0;
}
```

Wrong:
```javascript
function normalizeTs(rawTs) {
  return typeof rawTs === "number" ? rawTs : 0;
}
```
