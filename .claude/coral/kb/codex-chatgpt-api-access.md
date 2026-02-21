# Codex ChatGPT API Access from Node.js

## Rule
To call `chatgpt.com` APIs from Node.js (scripts, HUD tools, etc.), you **must** use the native `fetch()` API. Node.js's built-in `https` module is blocked by Cloudflare challenge (`cf-mitigated: challenge`). The required headers are `Authorization: Bearer <token>`, `chatgpt-account-id: <accountId>`, `User-Agent: codex_cli_rs/0.104.0`, and `originator: codex_cli_rs`.

## Why
Cloudflare runs fingerprinting on the TLS/HTTP stack. Node.js's `https.request()` fails with a 403 and Cloudflare's HTML challenge page. The native `fetch()` (Node 18+, via undici) passes the fingerprint check. `curl` also fails. This affects all `chatgpt.com/backend-api/*` endpoints.

## Pattern

**Wrong** — blocked by Cloudflare:
```javascript
import https from "https";
https.request({ hostname: "chatgpt.com", path: "/backend-api/wham/usage", ... }, ...)
```

**Right** — passes Cloudflare:
```javascript
const resp = await fetch("https://chatgpt.com/backend-api/wham/usage", {
  headers: {
    Authorization: `Bearer ${accessToken}`,
    "chatgpt-account-id": accountId,
    "User-Agent": "codex_cli_rs/0.104.0",
    originator: "codex_cli_rs",
  },
  signal,  // always pass an AbortController signal for timeout enforcement
});
```

**Codex rate limit endpoint** (free, no token cost):
```
GET https://chatgpt.com/backend-api/wham/usage
```
Returns both codex and spark limits in a single call:
```json
{
  "rate_limit": {
    "primary_window": { "used_percent": 8, "reset_at": 1234567890 },
    "secondary_window": { "used_percent": 22, "reset_at": 1234567890 }
  },
  "additional_rate_limits": [{
    "limit_name": "GPT-5.3-Codex-Spark",
    "metered_feature": "codex_bengalfox",
    "rate_limit": {
      "primary_window": { "used_percent": 0, "reset_at": 1234567890 },
      "secondary_window": { "used_percent": 0, "reset_at": 1234567890 }
    }
  }]
}
```
- `used_percent`: integer 0-100 (NOT fractional 0.0-1.0 like Claude's `utilization`)
- `reset_at`: Unix **seconds** — convert via `new Date(reset_at * 1000)`
- Spark limits in `additional_rate_limits[]` where `metered_feature === "codex_bengalfox"`
- Derive codex model name: `limit_name.replace(/-Spark$/i, "").toLowerCase()` → `"gpt-5.3-codex"`

**Auth.json location**: `~/.codex/auth.json`
```json
{ "auth_mode": "chatgpt", "tokens": { "access_token": "...", "refresh_token": "...", "account_id": "..." } }
```

**Token refresh**:
```javascript
POST https://auth.openai.com/oauth/token
body: grant_type=refresh_token&client_id=app_EMoamEEZ73f0CkXaXp7hrann&refresh_token=...&scope=openid profile email
```
Returns `{ access_token }`. Never write the refreshed token back to `~/.codex/auth.json` — Codex CLI manages its own credentials. Cache the refreshed token in your own cache file instead.
