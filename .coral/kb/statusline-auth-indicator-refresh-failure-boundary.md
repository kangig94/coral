# Statusline Auth Indicator Refresh Failure Boundary
## Rule
Reserve `re-login required` for explicit authentication evidence. In a refresh flow, that means the post-refresh API call is still unauthorized; a failed refresh request by itself is not enough to prove the session is invalid.
## Why
Refresh endpoints can fail for reasons unrelated to credentials: timeouts, transport errors, and server-side failures all look like "refresh returned null" if the helper collapses non-OK responses. If the HUD maps that generic refresh failure to an auth indicator, it tells the user to re-authenticate when the real problem is service availability.
## Pattern
Right:
```javascript
if (firstResult?.unauthorized) {
  const refreshed = await refreshToken(...);
  if (!refreshed) return { kind: "error", message: "API unavailable" };
  const secondResult = await fetchUsage(...);
  if (secondResult?.unauthorized) return { kind: "error", message: "re-login required" };
}
```

Wrong:
```javascript
if (firstResult?.unauthorized) {
  const refreshed = await refreshToken(...);
  if (!refreshed) return { kind: "error", message: "re-login required" };
}
```
