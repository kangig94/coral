---
name: statusline
description: Install or remove coral HUD statusline
argument-hint: "[install|uninstall]"
---

# Coral Statusline

Manage the coral HUD statusline for Claude Code.

## Commands

### install

1. Write the HUD script below to `~/.claude/hud/coral-hud.mjs` (create `~/.claude/hud/` directory if needed)
2. Read `~/.claude/settings.json` (create if absent)
3. If `statusLine` already exists and is NOT coral's, **ask the user** before overwriting
4. Set `statusLine` to:
   ```json
   {
     "statusLine": {
       "type": "command",
       "command": "node ~/.claude/hud/coral-hud.mjs"
     }
   }
   ```
   Replace `~` with the actual home directory path.
5. Confirm installation to the user

### uninstall

1. Read `~/.claude/settings.json`
2. Remove the `statusLine` key
3. Delete `~/.claude/hud/coral-hud.mjs` and `~/.claude/hud/.coral-usage-cache.json`
4. Confirm removal to the user

---

## HUD Script

Write the following script **exactly** to `~/.claude/hud/coral-hud.mjs`:

```javascript
#!/usr/bin/env node

// Coral HUD Statusline
// Elements: model | session | context | limits

import { readFileSync, existsSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { execSync } from "child_process";
import https from "https";

const SEP = " \u2502 ";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

// --- stdin ---

async function readStdin() {
  if (process.stdin.isTTY) return null;
  const chunks = [];
  process.stdin.setEncoding("utf8");
  try {
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
    }
    const raw = chunks.join("");
    if (!raw.trim()) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// --- elements ---

function renderModel(input) {
  if (!input.model) return null;
  const name = input.model.display_name || input.model.id || "";
  return name.toLowerCase();
}

function renderSession(input) {
  if (!input.cost?.total_duration_ms) return null;
  const totalSec = Math.floor(input.cost.total_duration_ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return `${hr}h${remMin > 0 ? remMin + "m" : ""}`;
}

function renderContext(input) {
  const ctx = input.context_window;
  if (!ctx) return null;
  const pct = ctx.used_percentage;
  if (pct == null) return null;
  let color = GREEN;
  if (pct > 85) color = RED;
  else if (pct > 70) color = YELLOW;
  return `ctx:${color}${pct}%${RESET}`;
}

// --- rate limits via OAuth API ---

const CACHE_DIR = join(homedir(), ".claude", "hud");
const CACHE_FILE = join(CACHE_DIR, ".coral-usage-cache.json");
const CACHE_TTL_MS = 30_000;
const CACHE_FAIL_TTL_MS = 15_000;
const API_TIMEOUT_MS = 5_000;

function readCache() {
  try {
    if (!existsSync(CACHE_FILE)) return null;
    const cache = JSON.parse(readFileSync(CACHE_FILE, "utf-8"));
    const ttl = cache.error ? CACHE_FAIL_TTL_MS : CACHE_TTL_MS;
    if (Date.now() - cache.ts > ttl) return null;
    return cache.data;
  } catch {
    return null;
  }
}

function writeCache(data, error = false) {
  try {
    if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify({ ts: Date.now(), data, error }));
  } catch {}
}

const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

function readRawCredentials() {
  // macOS Keychain
  if (process.platform === "darwin") {
    try {
      const raw = execSync(
        '/usr/bin/security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null',
        { encoding: "utf-8", timeout: 2000 }
      ).trim();
      if (raw) {
        const parsed = JSON.parse(raw);
        return parsed.claudeAiOauth || parsed;
      }
    } catch {}
  }
  // File fallback
  try {
    const credPath = join(homedir(), ".claude", ".credentials.json");
    if (!existsSync(credPath)) return null;
    const parsed = JSON.parse(readFileSync(credPath, "utf-8"));
    return parsed.claudeAiOauth || parsed;
  } catch {
    return null;
  }
}

function refreshToken(refreshTok) {
  return new Promise((resolve) => {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshTok,
      client_id: OAUTH_CLIENT_ID,
    }).toString();
    const req = https.request(
      {
        hostname: "platform.claude.com",
        path: "/v1/oauth/token",
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(body),
        },
        timeout: API_TIMEOUT_MS,
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          if (res.statusCode === 200) {
            try {
              const p = JSON.parse(data);
              if (p.access_token) {
                // Write back to credentials file
                try {
                  const credPath = join(homedir(), ".claude", ".credentials.json");
                  if (existsSync(credPath)) {
                    const file = JSON.parse(readFileSync(credPath, "utf-8"));
                    const target = file.claudeAiOauth || file;
                    target.accessToken = p.access_token;
                    if (p.refresh_token) target.refreshToken = p.refresh_token;
                    if (p.expires_in) target.expiresAt = Date.now() + p.expires_in * 1000;
                    writeFileSync(credPath, JSON.stringify(file, null, 2), { mode: 0o600 });
                  }
                } catch {}
                resolve(p.access_token);
                return;
              }
            } catch {}
          }
          resolve(null);
        });
      }
    );
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.end(body);
  });
}

async function getCredentials() {
  const creds = readRawCredentials();
  if (!creds || !creds.accessToken) return null;

  // Check if expired
  if (creds.expiresAt && creds.expiresAt <= Date.now()) {
    if (creds.refreshToken) {
      return await refreshToken(creds.refreshToken);
    }
    return null;
  }
  return creds.accessToken;
}

function fetchUsage(accessToken) {
  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: "api.anthropic.com",
        path: "/api/oauth/usage",
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "anthropic-beta": "oauth-2025-04-20",
          "Content-Type": "application/json",
        },
        timeout: API_TIMEOUT_MS,
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          if (res.statusCode === 200) {
            try { resolve(JSON.parse(data)); } catch { resolve(null); }
          } else {
            resolve(null);
          }
        });
      }
    );
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.end();
  });
}

function colorPct(pct) {
  let color = GREEN;
  if (pct >= 90) color = RED;
  else if (pct >= 70) color = YELLOW;
  return `${color}${pct}%${RESET}`;
}

async function renderLimits() {
  const cached = readCache();
  if (cached) return formatLimits(cached);

  const token = await getCredentials();
  if (!token) return null;

  const resp = await fetchUsage(token);
  if (!resp) {
    writeCache(null, true);
    return null;
  }

  const data = {
    fiveHour: resp.five_hour?.utilization,
    weekly: resp.seven_day?.utilization,
    fiveHourResetsAt: resp.five_hour?.resets_at || null,
    weeklyResetsAt: resp.seven_day?.resets_at || null,
  };
  writeCache(data);
  return formatLimits(data);
}

function formatResetTime(isoString, mode) {
  if (!isoString) return null;
  const diffMs = new Date(isoString).getTime() - Date.now();
  if (diffMs <= 0) return null;
  const totalMin = Math.floor(diffMs / 60000);
  const totalHr = Math.floor(totalMin / 60);
  const totalDays = Math.floor(totalHr / 24);
  if (mode === "wk" && totalHr >= 24) {
    return `${(totalHr / 24).toFixed(1)}d`;
  }
  const mm = totalMin % 60;
  return `${totalHr}:${String(mm).padStart(2, "0")}`;
}

function formatLimits(data) {
  if (!data) return null;
  const parts = [];
  if (data.fiveHour != null) {
    const pct = Math.round(Math.min(100, Math.max(0, data.fiveHour)));
    const reset = formatResetTime(data.fiveHourResetsAt, "5h");
    const resetStr = reset ? ` ${DIM}(${reset})${RESET}` : "";
    parts.push(`5h:${colorPct(pct)}${resetStr}`);
  }
  if (data.weekly != null) {
    const pct = Math.round(Math.min(100, Math.max(0, data.weekly)));
    const reset = formatResetTime(data.weeklyResetsAt, "wk");
    const resetStr = reset ? ` ${DIM}(${reset})${RESET}` : "";
    parts.push(`${DIM}wk:${RESET}${colorPct(pct)}${resetStr}`);
  }
  return parts.length > 0 ? parts.join(" ") : null;
}

// --- main ---

async function main() {
  const input = await readStdin();
  if (!input) {
    process.stdout.write("");
    return;
  }

  const limits = await renderLimits();

  const elements = [
    renderModel(input),
    renderSession(input),
    limits,
    renderContext(input),
  ].filter(Boolean);

  process.stdout.write(elements.join(SEP));
}

main().catch(() => process.stdout.write(""));
```

## Notes

- The HUD script must be written **exactly as shown above** — do not modify the logic
- `~` must be expanded to the real home directory in both the file path and settings.json command
- If re-running install, overwrite the existing script (this updates the HUD to the latest version)
- Rate limits are fetched from `api.anthropic.com/api/oauth/usage` using OAuth credentials
- Results are cached for 30 seconds to avoid excessive API calls
- Token refresh is automatic when credentials expire
- If credentials are unavailable (e.g., API key users), rate limits are silently omitted
