# Statusline Auth Indicator OAuth vs API Key
## Rule
Reserve `re-login required` style messaging for explicit authentication failures, not for every missing-credential path, when the product supports credential modes that legitimately omit the token being checked.
## Why
A statusline that reads one credential source can mistake an unsupported-or-unused auth mode for an expired login. In `coral-hud`, Claude usage requires OAuth credentials, but the skill documentation treats API-key users as a normal case where the usage section is silently absent. Turning `!token` into `re-login required` would give a misleading action prompt in that supported environment while still missing real 401/403 cases.
## Pattern
Right:
```javascript
if (resp.status === 401 || resp.status === 403) return { unauthorized: true };
if (!token) return null; // unsupported or unused auth mode stays silent
```

Wrong:
```javascript
if (!token) return "re-login required";
// every non-OAuth setup now looks like an expired login
```
