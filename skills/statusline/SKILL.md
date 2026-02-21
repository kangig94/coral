---
name: statusline
description: Install or remove coral HUD statusline
argument-hint: "[install|uninstall]"
disable-model-invocation: true
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
5. Check if `~/.codex/auth.json` exists:
   - If yes, ask the user: "Codex login detected. Display Codex usage in statusline?"
     - **yes** → create `~/.claude/hud/.coral-codex-enabled` (empty file)
     - **no** → delete `~/.claude/hud/.coral-codex-enabled` and `~/.claude/hud/.coral-codex-usage-cache.json` if they exist
   - If no `auth.json`, skip silently (do not create or delete any Codex files)
6. Confirm installation to the user

### uninstall

1. Read `~/.claude/settings.json`
2. Remove the `statusLine` key
3. Delete the following files if they exist:
   - `~/.claude/hud/coral-hud.mjs`
   - `~/.claude/hud/.coral-usage-cache.json`
   - `~/.claude/hud/.coral-codex-usage-cache.json`
   - `~/.claude/hud/.coral-codex-enabled`
4. Confirm removal to the user

---

## HUD Script

Write the following script to `~/.claude/hud/coral-hud.mjs` to update the HUD to the latest version:

```javascript
#!/usr/bin/env node

// Coral HUD Statusline
// Line 1: model │ limits │ ctx │ session │ skill
// Line 2: codex model │ codex limits │ spark limits

import { readFileSync, existsSync, writeFileSync, mkdirSync, openSync, fstatSync, readSync, closeSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { execSync } from "child_process";
import https from "https";

const SEP = " \u2502 ";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const CYAN = "\x1b[36m";

const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_USER_AGENT = "codex_cli_rs/0.104.0";

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
  return name.toLowerCase().replace(/^claude\s+/, "");
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
  return `ctx:${color}${String(pct).padStart(2)}%${RESET}`;
}

const STALE_AGENT_MS = 30 * 60 * 1000;

function readTranscriptTail(transcriptPath) {
  if (!transcriptPath) return null;
  let fd;
  try {
    fd = openSync(transcriptPath, "r");
    const { size } = fstatSync(fd);
    const readSize = Math.min(size, 500 * 1024);
    const buf = Buffer.alloc(readSize);
    readSync(fd, buf, 0, readSize, size - readSize);
    const lines = buf.toString("utf-8").split("\n");
    if (size > readSize) lines.shift(); // drop potentially incomplete first line
    return lines;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function parseLastSkill(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    // Case 1: user-typed slash command → user message with <command-message> tag
    if (line.includes("command-message")) {
      try {
        const entry = JSON.parse(line);
        const content = entry?.message?.content;
        if (typeof content === "string") {
          const m = content.match(/<command-message>([^<]+)<\/command-message>/);
          if (m?.[1]) return m[1];
        }
      } catch {}
    }
    // Case 2: Claude-invoked Skill tool_use (e.g. ralph calling /commit)
    if (line.includes('"tool_use"') && (line.includes('"Skill"') || line.includes('"proxy_Skill"'))) {
      try {
        const entry = JSON.parse(line);
        const blocks = entry?.message?.content;
        if (!Array.isArray(blocks)) continue;
        for (let j = blocks.length - 1; j >= 0; j--) {
          const block = blocks[j];
          if (block.type === "tool_use"
              && (block.name === "Skill" || block.name === "proxy_Skill")
              && block.input?.skill) {
            return block.input.skill;
          }
        }
      } catch {}
    }
  }
  return null;
}

function parseRunningAgents(lines) {
  const agentMap = new Map();
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      const content = entry?.message?.content;
      const ts = entry.timestamp ? new Date(entry.timestamp) : null;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (block.type === "tool_use"
            && (block.name === "Task" || block.name === "proxy_Task")
            && block.id) {
          agentMap.set(block.id, {
            subagent_type: block.input?.subagent_type || "unknown",
            startTime: ts,
          });
        }
        if (block.type === "tool_result" && block.tool_use_id) {
          agentMap.delete(block.tool_use_id);
        }
      }
    } catch {}
  }
  const now = Date.now();
  return Array.from(agentMap.values()).filter(a =>
    !a.startTime || now - a.startTime.getTime() < STALE_AGENT_MS
  );
}

function renderActivity(input) {
  const lines = readTranscriptTail(input.transcript_path);
  if (!lines) return null;
  const running = parseRunningAgents(lines);
  if (running.length > 0) {
    const counts = {};
    for (const a of running) counts[a.subagent_type] = (counts[a.subagent_type] || 0) + 1;
    const str = Object.entries(counts).map(([t, c]) => c > 1 ? `${t}×${c}` : t).join(" ");
    return `${DIM}${str}${RESET}`;
  }
  const skill = parseLastSkill(lines);
  if (!skill) return null;
  return `${CYAN}${skill}${RESET}`;
}

// --- cache ---

const CACHE_DIR = join(homedir(), ".claude", "hud");
const CACHE_FILE = join(CACHE_DIR, ".coral-usage-cache.json");
const CODEX_CACHE_FILE = join(CACHE_DIR, ".coral-codex-usage-cache.json");
const CODEX_FLAG_FILE = join(CACHE_DIR, ".coral-codex-enabled");
const CACHE_TTL_MS = 30_000;
const CACHE_FAIL_TTL_MS = 15_000;
const API_TIMEOUT_MS = 5_000;

function readCacheFile(path) {
  try {
    const cache = JSON.parse(readFileSync(path, "utf-8"));
    const ttl = cache.error ? CACHE_FAIL_TTL_MS : CACHE_TTL_MS;
    if (Date.now() - cache.ts > ttl) return null;
    return cache.data;
  } catch {
    return null;
  }
}

function writeCacheFile(path, data, error = false, extra = null) {
  try {
    if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
    const payload = { ts: Date.now(), data, error, ...extra };
    writeFileSync(path, JSON.stringify(payload), { mode: 0o600 });
  } catch {}
}

// --- Claude rate limits ---

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
  if (!creds?.accessToken) return null;
  if (creds.expiresAt && creds.expiresAt <= Date.now()) {
    return creds.refreshToken ? refreshToken(creds.refreshToken) : null;
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

function clampPct(val) {
  return Math.round(Math.min(100, Math.max(0, val)));
}

function colorPct(pct) {
  let color = GREEN;
  if (pct >= 90) color = RED;
  else if (pct >= 70) color = YELLOW;
  return `${color}${String(pct).padStart(2)}%${RESET}`;
}

function formatResetTime(isoString, mode) {
  if (!isoString) return null;
  const diffMs = new Date(isoString).getTime() - Date.now();
  if (diffMs <= 0) return null;
  const totalMin = Math.floor(diffMs / 60000);
  const totalHr = Math.floor(totalMin / 60);
  if (mode === "wk" && totalHr >= 24) {
    return `${(totalHr / 24).toFixed(1)}d`;
  }
  const mm = totalMin % 60;
  return `${totalHr}:${String(mm).padStart(2, "0")}`;
}

function formatWindow(label, val, resetsAt, mode, dim = false) {
  if (val == null) return null;
  const pct = clampPct(val);
  const reset = formatResetTime(resetsAt, mode);
  const resetStr = reset ? ` ${DIM}(${reset})${RESET}` : "";
  const prefix = dim ? `${DIM}${label}:${RESET}` : `${label}:`;
  return `${prefix}${colorPct(pct)}${resetStr}`;
}

function formatLimits(data) {
  if (!data) return null;
  const parts = [
    formatWindow("5h", data.fiveHour, data.fiveHourResetsAt, "5h"),
    formatWindow("wk", data.weekly, data.weeklyResetsAt, "wk", true),
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : null;
}

async function renderLimits() {
  const cached = readCacheFile(CACHE_FILE);
  if (cached) return formatLimits(cached);

  const token = await getCredentials();
  if (!token) return null;

  const resp = await fetchUsage(token);
  if (!resp) {
    writeCacheFile(CACHE_FILE, null, true);
    return null;
  }

  const data = {
    fiveHour: resp.five_hour?.utilization,
    weekly: resp.seven_day?.utilization,
    fiveHourResetsAt: resp.five_hour?.resets_at || null,
    weeklyResetsAt: resp.seven_day?.resets_at || null,
  };
  writeCacheFile(CACHE_FILE, data);
  return formatLimits(data);
}

// --- Codex rate limits ---

function readCodexCredentials() {
  try {
    const authPath = join(homedir(), ".codex", "auth.json");
    if (!existsSync(authPath)) return null;
    const parsed = JSON.parse(readFileSync(authPath, "utf-8"));
    const { access_token, refresh_token, account_id } = parsed.tokens || {};
    if (!account_id) return null;
    return { accessToken: access_token, refreshToken: refresh_token, accountId: account_id };
  } catch {
    return null;
  }
}

async function refreshCodexToken(refreshTok, signal) {
  try {
    const resp = await fetch("https://auth.openai.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: CODEX_CLIENT_ID,
        refresh_token: refreshTok,
        scope: "openid profile email",
      }),
      signal,
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return data.access_token || null;
  } catch {
    return null;
  }
}

function parseLimitsFromRl(rl) {
  if (!rl) return null;
  function parseWindow(w) {
    if (!w) return { pct: null, resetsAt: null };
    return {
      pct: w.used_percent ?? null,
      resetsAt: w.reset_at != null ? new Date(w.reset_at * 1000).toISOString() : null,
    };
  }
  const pri = parseWindow(rl.primary_window);
  const sec = parseWindow(rl.secondary_window);
  return {
    fiveHour: pri.pct, weekly: sec.pct,
    fiveHourResetsAt: pri.resetsAt, weeklyResetsAt: sec.resetsAt,
  };
}

async function fetchCodexUsage(accessToken, accountId, signal) {
  try {
    const resp = await fetch("https://chatgpt.com/backend-api/wham/usage", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "chatgpt-account-id": accountId,
        "User-Agent": CODEX_USER_AGENT,
        originator: "codex_cli_rs",
      },
      signal,
    });
    if (resp.status === 401) return { unauthorized: true };
    if (!resp.ok) return null;
    const body = await resp.json();

    const codex = parseLimitsFromRl(body.rate_limit);

    let spark = null;
    let modelName = "codex";
    let additionalLabel = "spark";
    const addEntry = (body.additional_rate_limits || [])
      .find(e => e.metered_feature === "codex_bengalfox");
    if (addEntry?.limit_name) {
      const lower = addEntry.limit_name.toLowerCase();
      const lastDash = lower.lastIndexOf("-");
      if (lastDash >= 0) {
        modelName = lower.slice(0, lastDash);
        additionalLabel = lower.slice(lastDash + 1);
      } else {
        modelName = lower;
      }
      spark = parseLimitsFromRl(addEntry.rate_limit);
    }

    return { codex, spark, modelName, additionalLabel };
  } catch {
    return null;
  }
}

function readRawCache(path) {
  try { return JSON.parse(readFileSync(path, "utf-8")); } catch { return null; }
}

async function renderCodexData() {
  if (!existsSync(CODEX_FLAG_FILE)) return null;

  const rawCache = readRawCache(CODEX_CACHE_FILE);

  // Return cached data if fresh
  if (rawCache?.ts) {
    const age = Date.now() - rawCache.ts;
    if (rawCache.error && age <= CACHE_FAIL_TTL_MS) return null;
    if (!rawCache.error && age <= CACHE_TTL_MS && rawCache.data) {
      return rawCache.data;
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

  try {
    const creds = readCodexCredentials();
    if (!creds) return null;

    // Prefer cached token if not expired (independent of data TTL)
    let token = rawCache?.cachedToken?.expiresAt > Date.now()
      ? rawCache.cachedToken.accessToken
      : creds.accessToken;

    let result = await fetchCodexUsage(token, creds.accountId, controller.signal);

    // 401: refresh once and retry within same deadline
    if (result?.unauthorized) {
      const newToken = await refreshCodexToken(creds.refreshToken, controller.signal);
      if (!newToken) { writeCacheFile(CODEX_CACHE_FILE, null, true); return null; }
      token = newToken;
      result = await fetchCodexUsage(token, creds.accountId, controller.signal);
    }

    if (result && !result.unauthorized) {
      writeCacheFile(CODEX_CACHE_FILE, result, false, {
        cachedToken: { accessToken: token, expiresAt: Date.now() + 600_000 },
      });
      return result;
    }

    writeCacheFile(CODEX_CACHE_FILE, null, true);
    return null;
  } catch {
    writeCacheFile(CODEX_CACHE_FILE, null, true);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// --- main ---

function visualLen(str) {
  return str.replace(/\x1b\[[0-9;]*m/g, "").length;
}

function padVisual(str, len) {
  const pad = len - visualLen(str);
  return pad > 0 ? str + " ".repeat(pad) : str;
}

function alignColumns(a, b) {
  if (!a || !b) return [a, b];
  const w = Math.max(visualLen(a), visualLen(b));
  return [padVisual(a, w), padVisual(b, w)];
}

async function main() {
  const input = await readStdin();
  if (!input) {
    process.stdout.write("");
    return;
  }

  const safe = (p) => p.catch(() => null);
  const [limits, codexData] = await Promise.all([
    safe(renderLimits()),
    safe(renderCodexData()),
  ]);

  // Column alignment: model name + limits (up to second |)
  const claudeModel = renderModel(input);
  const envModel = process.env.CORAL_CODEX_MODEL || "gpt-5.3-codex";
  const addonTier = codexData?.additionalLabel?.toLowerCase() || null;
  const hasAddon = addonTier ? envModel.toLowerCase().endsWith(`-${addonTier}`) : false;
  const baseModel = hasAddon ? envModel.slice(0, envModel.lastIndexOf("-")) : envModel;
  const codexModel = codexData ? baseModel : null;

  let [col1Claude, col1Codex] = alignColumns(claudeModel, codexModel);
  const codexLimits = codexData ? formatLimits(codexData.codex) : null;
  const [col2Claude, col2Codex] = alignColumns(limits, codexLimits);

  // Line 1: Claude
  const line1 = [
    col1Claude,
    col2Claude,
    renderContext(input),
    renderSession(input),
    renderActivity(input),
  ].filter(Boolean);

  let output = line1.join(SEP);

  // Line 2: Codex (only if data available)
  if (codexData) {
    const sparkLabel = hasAddon ? `${GREEN}${codexData.additionalLabel}${RESET}` : codexData.additionalLabel;
    const sparkStr = codexData.spark ? `${sparkLabel} ${formatLimits(codexData.spark)}` : null;
    if (col1Codex) col1Codex = hasAddon ? col1Codex : `${GREEN}${col1Codex}${RESET}`;
    const line2 = [
      col1Codex,
      col2Codex,
      sparkStr,
    ].filter(Boolean);
    if (line2.length > 0) {
      output += "\n" + line2.join(SEP);
    }
  }

  process.stdout.write(output);
}

main().catch(() => process.stdout.write(""));
```

## Notes

- `~` must be expanded to the real home directory in both the file path and settings.json command
- If re-running install, overwrite the existing script (this updates the HUD to the latest version)
- Claude rate limits are fetched from `api.anthropic.com/api/oauth/usage` using OAuth credentials
- Codex rate limits and spark limits are fetched from `chatgpt.com/backend-api/wham/usage` (GET, no token cost); requires Codex login (`~/.codex/auth.json`)
- Two-line layout: Line 1 (Claude) shows model, limits, ctx, session, and last active skill; Line 2 (Codex) shows codex model, codex limits, and spark limits
- Skill detection reads last 200KB of `transcript_path` JSONL (tail-read for performance), finds last `Skill` or `proxy_Skill` tool_use block
- Both fetches run in parallel; either section is silently omitted on failure
- Results are cached for 30 seconds to avoid excessive API calls (`~/.claude/hud/.coral-usage-cache.json`, `~/.claude/hud/.coral-codex-usage-cache.json`)
- Codex opt-in is controlled by `~/.claude/hud/.coral-codex-enabled` flag file; managed during install
- If credentials are unavailable (e.g., API key users or Codex not installed), the respective rate limit section is silently omitted
