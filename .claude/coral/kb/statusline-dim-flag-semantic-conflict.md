# Statusline Dim Flag Semantic Conflict
## Rule
When an existing formatting flag already controls one visual detail on the success path, do not reuse that same parameter for a broader stale/error rendering mode. Introduce a separate mechanism so success rendering semantics stay unchanged.
## Why
Reusing a flag with a different meaning creates silent regressions because existing call sites keep passing the old value. In `coral-hud`, `formatWindow(..., dim=true)` already means "dim the weekly label", so redefining it to mean "dim the whole stale window" would alter normal output while looking superficially correct.
## Pattern
Right:
```javascript
function formatWindow(label, val, resetsAt, mode, dimLabel = false, dimWhole = false) {
  // Preserve existing success-path styling; stale rendering is separate.
}
```

Wrong:
```javascript
function formatWindow(label, val, resetsAt, mode, dim = false) {
  // Existing callers now get whole-window dimming by accident.
}
```
