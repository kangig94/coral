#!/usr/bin/env node

// Coral HUD Statusline
// Line 1: model │ limits │ ctx │ session │ skill
// Line 2: codex model │ codex limits │ spark limits

import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync, openSync, fstatSync, statSync, readSync, closeSync, renameSync, unlinkSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { execSync } from "child_process";
const SEP = " \u2502 ";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const CYAN = "\x1b[36m";
const MAGENTA = "\x1b[35m";
const CODEX_USER_AGENT = "codex_cli_rs/0.117.0";


function getCodexClientId(idToken) {
  try {
    const payload = JSON.parse(Buffer.from(idToken.split(".")[1], "base64url").toString());
    const aud = payload.aud;
    return Array.isArray(aud) ? aud[0] : aud;
  } catch {
    return null;
  }
}

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

// --- git ---

function renderGitBranch(input) {
  const cwd = input.cwd || input.workspace?.current_dir || input.workspace?.project_dir;
  if (!cwd) return null;
  try {
    const opts = { encoding: "utf8", stdio: ["pipe", "pipe", "ignore"], cwd, timeout: 2000 };
    const branch = execSync("git branch --show-current", opts).trim()
      || execSync("git rev-parse --short HEAD", opts).trim();
    if (!branch) return null;
    const dirty = execSync("git status --porcelain", opts).trim() ? `${YELLOW}*${RESET}` : "";
    return `${CYAN}⎇ ${branch}${RESET}${dirty}`;
  } catch {
    return null;
  }
}

// --- elements ---

function renderModel(input) {
  if (!input.model) return null;
  const name = input.model.display_name || input.model.id || "";
  return name.toLowerCase()
    .replace(/^claude\s+/, "")
    .replace(/\(200k\s+context\)/i, "")
    .replace(/\((\d+[km])\s+context\)/i, "$1")
    .replace(/\s+$/, "");
}

function renderSession(input) {
  const costUsd = input.cost?.total_cost_usd;
  const durationMs = input.cost?.total_duration_ms;

  let costStr = null;
  if (costUsd > 0) {
    if (costUsd < 1) costStr = `$${costUsd.toFixed(2)}`;
    else if (costUsd < 100) costStr = `$${costUsd.toFixed(1)}`;
    else costStr = `$${costUsd.toFixed(0)}`;
  }

  let durationStr = null;
  if (durationMs > 0) {
    const totalSec = Math.floor(durationMs / 1000);
    if (totalSec < 60) durationStr = `${totalSec}s`;
    else {
      const min = Math.floor(totalSec / 60);
      if (min < 60) durationStr = `${min}m`;
      else {
        const hr = Math.floor(min / 60);
        const remMin = min % 60;
        durationStr = `${hr}h${remMin > 0 ? remMin + "m" : ""}`;
      }
    }
  }

  const parts = [costStr, durationStr].filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : null;
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
const SESSION_PRUNE_MS = 60 * 60 * 1000;
const ACTIVITY_TTL_MS = 60 * 60 * 1000;

function readTranscriptTail(transcriptPath) {
  if (!transcriptPath) return null;
  let fd;
  try {
    fd = openSync(transcriptPath, "r");
    const { size } = fstatSync(fd);
    const readSize = Math.min(size, 512 * 1024);
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
    if (!line.includes('"tool_use"') && !line.includes('"tool_result"')) continue;
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

function extractUserText(raw) {
  // Command invocation: extract /name + args as the original input
  const cmdMatch = raw.match(/<command-name>([^<]+)<\/command-name>/);
  if (cmdMatch) {
    const name = cmdMatch[1].trim();
    const argsMatch = raw.match(/<command-args>([^<]*)<\/command-args>/);
    const args = argsMatch?.[1]?.trim();
    return args ? `${name} ${args}` : name;
  }
  // System-injected content — skip entirely
  if (/<task-notification>|<local-command|^Base directory for this skill:|^This session is being continued from|^Stop hook feedback:/i.test(raw)) return null;
  // Strip remaining XML tags (system-reminder etc.) and noise markers
  const clean = raw.replace(/<[^>]+>/g, "").trim();
  if (!clean || /^\[Request interrupted|^\[Tool cancelled|^\[User cancelled/i.test(clean)) return null;
  return clean;
}

function parseLastUserMessage(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.includes('"user"')) continue;
    try {
      const entry = JSON.parse(line);
      if (entry?.type !== "human" && entry?.message?.role !== "user") continue;
      const content = entry?.message?.content;
      if (typeof content === "string") {
        const text = extractUserText(content);
        if (text) return text;
      }
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "text" && typeof block.text === "string") {
            const text = extractUserText(block.text);
            if (text) return text;
          }
        }
      }
    } catch {}
  }
  return null;
}

function formatAgentCounts(agents) {
  const counts = {};
  for (const a of agents) counts[a.subagent_type] = (counts[a.subagent_type] || 0) + 1;
  return `${DIM}${Object.entries(counts).map(([t, c]) => c > 1 ? `${t}×${c}` : t).join(" ")}${RESET}`;
}

function renderActivityStr(agents, activity) {
  const agentList = Array.isArray(agents) ? agents : Object.values(agents || {});
  if (agentList.length > 0) return formatAgentCounts(agentList);
  if (activity?.name && activity?.ts && (Date.now() - activity.ts < ACTIVITY_TTL_MS)) {
    return `${CYAN}${activity.name}${RESET}`;
  }
  return null;
}

function parseTranscript(input) {
  const sessionId = input.session_id;
  const transcriptPath = input.transcript_path;

  let transcriptSize = 0;
  try { transcriptSize = statSync(transcriptPath).size; } catch {}

  const cached = sessionId ? readSessionEntry(sessionId) : null;

  if (cached && cached.transcriptSize === transcriptSize) {
    const agents = cached.agents || {};
    return {
      activity: renderActivityStr(agents, cached.activity),
      lastUserMessage: cached.prompt,
      _session: { activity: cached.activity, agents, prompt: cached.prompt, transcriptSize },
    };
  }

  const lines = readTranscriptTail(transcriptPath);
  if (!lines) return { activity: null, lastUserMessage: null, _session: { activity: null, agents: {}, prompt: null, transcriptSize } };

  const running = parseRunningAgents(lines);
  const skill = parseLastSkill(lines);
  const prompt = parseLastUserMessage(lines);

  const agentsMap = {};
  running.forEach((a, i) => {
    agentsMap[i] = { subagent_type: a.subagent_type, ts: a.startTime?.getTime() || Date.now() };
  });

  const now = Date.now();
  const activity = skill
    ? { name: skill, ts: (cached?.activity?.name === skill ? cached.activity.ts : now) }
    : (cached?.activity || null);

  return {
    activity: renderActivityStr(running, activity),
    lastUserMessage: prompt,
    _session: { activity, agents: agentsMap, prompt, transcriptSize },
  };
}

// --- cache ---

const CACHE_DIR = join(homedir(), ".claude", "hud");
const CACHE_FILE = join(CACHE_DIR, ".coral-cache.json");
const BACKEND_CACHE_FILE = join(CACHE_DIR, ".coral-backend-cache.json");
const CODEX_FLAG_FILE = join(CACHE_DIR, ".coral-codex-enabled");
const CACHE_TTL_MS = 180_000;
const CACHE_FAIL_TTL_MS = 30_000;
const RATE_LIMIT_BASE_MS = 120_000;
const RATE_LIMIT_MAX_MS = 600_000;
const API_TIMEOUT_MS = 5_000;
const LOCK_STALE_MS = 10_000;
const CORAL_HEALTH_TTL_MS = 5_000;
const CORAL_HEALTH_TIMEOUT_MS = 3_000;

// --- session state ---

const SESSIONS_FILE = join(CACHE_DIR, ".coral-sessions.json");
let _sessionsCache = null;

function readSessions() {
  if (_sessionsCache) return _sessionsCache;
  try {
    _sessionsCache = JSON.parse(readFileSync(SESSIONS_FILE, "utf-8"));
  } catch {
    _sessionsCache = {};
  }
  return _sessionsCache;
}

function readSessionEntry(sessionId) {
  return readSessions()[sessionId] || null;
}

function writeSession(sessionId, data) {
  try {
    const all = readSessions();
    const existing = all[sessionId];
    if (existing && existing.ctx === data.ctx && existing.transcriptSize === data.transcriptSize) return;
    all[sessionId] = { ...data, ts: Date.now() };
    const now = Date.now();
    for (const key of Object.keys(all)) {
      if (now - (all[key]?.ts || 0) > SESSION_PRUNE_MS) delete all[key];
    }
    mkdirSync(CACHE_DIR, { recursive: true });
    const tmpPath = `${SESSIONS_FILE}.tmp-${process.pid}`;
    writeFileSync(tmpPath, JSON.stringify(all), { mode: 0o600 });
    renameSync(tmpPath, SESSIONS_FILE);
    _sessionsCache = all;
  } catch {}
}

function readFullCache() {
  try {
    return JSON.parse(readFileSync(CACHE_FILE, "utf-8"));
  } catch {
    return {};
  }
}

function writeFullCache(all) {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify(all), { mode: 0o600 });
  } catch {}
}

function normalizeCacheEntry(raw) {
  return {
    ts: Number.isFinite(raw?.ts) ? raw.ts : 0,
    data: raw?.data ?? null,
    error: Boolean(raw?.error),
    rateLimit: Number.isInteger(raw?.rateLimit) ? raw.rateLimit : 0,
    errorKind: raw?.errorKind ?? null,
  };
}

function getCacheTtlMs(cache) {
  if (cache.error && cache.rateLimit > 0) {
    return Math.min(RATE_LIMIT_BASE_MS * 2 ** (cache.rateLimit - 1), RATE_LIMIT_MAX_MS);
  }
  return cache.error ? CACHE_FAIL_TTL_MS : CACHE_TTL_MS;
}

function isFreshCacheEntry(cache, now = Date.now()) {
  if (cache.ts <= 0 || cache.ts > now) return false;
  if (now - cache.ts > getCacheTtlMs(cache)) return false;
  if (cache.data && !cache.error) {
    for (const rt of [cache.data.fiveHourResetsAt, cache.data.weeklyResetsAt]) {
      if (!rt) continue;
      const resetMs = new Date(rt).getTime();
      if (Number.isFinite(resetMs) && resetMs > cache.ts && resetMs <= now) return false;
    }
  }
  return true;
}

function readCacheSlot(key) {
  const entry = readFullCache()[key];
  if (!entry) return null;
  const cache = normalizeCacheEntry(entry);
  return isFreshCacheEntry(cache) ? cache : null;
}

function writeCacheSlot(key, data, error = false, rateLimit = 0, errorKind = null) {
  const all = readFullCache();
  let nextData = data;
  if (error && nextData == null) {
    const existing = normalizeCacheEntry(all[key]);
    if (existing.data != null) nextData = existing.data;
  }
  all[key] = { ts: Date.now(), data: nextData, error, rateLimit, errorKind };
  writeFullCache(all);
}

function readBackoffState(key) {
  try {
    const now = Date.now();
    const cache = normalizeCacheEntry(readFullCache()[key]);
    if (!cache.error || cache.rateLimit <= 0) return 0;
    if (cache.ts <= 0 || cache.ts > now) return 0;
    if (now - cache.ts > RATE_LIMIT_MAX_MS) return 0;
    return cache.rateLimit;
  } catch {
    return 0;
  }
}

function readStaleCacheData(key) {
  try {
    const cache = normalizeCacheEntry(readFullCache()[key]);
    if (cache.data) return formatLimits(cache.data);
    return null;
  } catch {
    return null;
  }
}

function acquireFetchLock(key) {
  const lockPath = join(CACHE_DIR, `.coral-${key}.lock`);
  try {
    const raw = readFileSync(lockPath, "utf-8");
    let isStale = true;
    try {
      const lockData = JSON.parse(raw);
      isStale = Date.now() - lockData.ts > LOCK_STALE_MS;
    } catch {} // corrupt/empty JSON → treat as stale
    if (!isStale) return null;
    try { unlinkSync(lockPath); } catch {}
  } catch {} // ENOENT → no lock exists
  try {
    writeFileSync(lockPath, JSON.stringify({ ts: Date.now() }), { flag: "wx", mode: 0o600 });
    return lockPath;
  } catch {
    return null;
  }
}

function releaseFetchLock(lockPath) {
  try { unlinkSync(lockPath); } catch {}
}

function readBackendSlot() {
  try {
    const raw = JSON.parse(readFileSync(BACKEND_CACHE_FILE, "utf-8"));
    if (!raw || !Number.isFinite(raw.ts)) return null;
    if (Date.now() - raw.ts > CORAL_HEALTH_TTL_MS) return null;
    return raw;
  } catch {
    return null;
  }
}

function readStaleBackendLine() {
  try {
    return JSON.parse(readFileSync(BACKEND_CACHE_FILE, "utf-8"))?.line ?? null;
  } catch {
    return null;
  }
}

function writeBackendSlot(line, online) {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    const tmp = `${BACKEND_CACHE_FILE}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify({ ts: Date.now(), line, online }), { mode: 0o600 });
    renameSync(tmp, BACKEND_CACHE_FILE);
  } catch {}
}

// --- Claude rate limits ---

function getClaudeAccessToken() {
  // macOS Keychain
  if (process.platform === "darwin") {
    try {
      const raw = execSync(
        '/usr/bin/security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null',
        { encoding: "utf-8", timeout: 2000 }
      ).trim();
      if (raw) {
        const parsed = JSON.parse(raw);
        return (parsed.claudeAiOauth || parsed).accessToken || null;
      }
    } catch {}
  }
  // File fallback
  try {
    const credPath = join(homedir(), ".claude", ".credentials.json");
    const parsed = JSON.parse(readFileSync(credPath, "utf-8"));
    return (parsed.claudeAiOauth || parsed).accessToken || null;
  } catch {
    return null;
  }
}

async function fetchUsage(accessToken, signal) {
  try {
    const resp = await fetch("https://api.anthropic.com/api/oauth/usage", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "anthropic-beta": "oauth-2025-04-20",
        "Content-Type": "application/json",
      },
      signal,
    });
    if (resp.status === 401 || resp.status === 403) return { unauthorized: true };
    if (resp.status === 429) return { rateLimited: true };
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  }
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

function formatWindow(label, val, resetsAt, mode, dimLabel = false) {
  if (val == null) return null;
  const pct = clampPct(val);
  const reset = formatResetTime(resetsAt, mode);
  const resetStr = reset ? ` ${DIM}(${reset})${RESET}` : "";
  const prefix = dimLabel ? `${DIM}${label}:${RESET}` : `${label}:`;
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

function formatRemainingTime(cache) {
  const remaining = cache.ts + getCacheTtlMs(cache) - Date.now();
  const minutes = Math.max(1, Math.ceil(remaining / 60000));
  return `${minutes}m`;
}

function formatErrorIndicator(cache) {
  switch (cache.errorKind) {
    case "rateLimit":
      return `${DIM}throttled: refreshes in ${formatRemainingTime(cache)}${RESET}`;
    case "auth":
      return `${DIM}re-login required${RESET}`;
    default:
      return `${DIM}API unavailable${RESET}`;
  }
}

function cacheError(slot, errorKind, rateLimit = 0) {
  writeCacheSlot(slot, null, true, rateLimit, errorKind);
  return formatErrorIndicator({ error: true, errorKind, ts: Date.now(), rateLimit });
}

async function renderLimits() {
  const cached = readCacheSlot("claude");
  if (cached) {
    if (cached.error) {
      if (cached.data) return formatLimits(cached.data);
      return formatErrorIndicator(cached);
    }
    return formatLimits(cached.data);
  }

  const lock = acquireFetchLock("claude");
  if (!lock) return readStaleCacheData("claude");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  try {
    const token = getClaudeAccessToken();
    if (!token) return null;

    const resp = await fetchUsage(token, controller.signal);
    if (resp?.unauthorized) return cacheError("claude", "auth");
    if (resp?.rateLimited) return cacheError("claude", "rateLimit", readBackoffState("claude") + 1);
    if (!resp) return cacheError("claude", "generic");

    const data = {
      fiveHour: resp.five_hour?.utilization,
      weekly: resp.seven_day?.utilization,
      fiveHourResetsAt: resp.five_hour?.resets_at || null,
      weeklyResetsAt: resp.seven_day?.resets_at || null,
    };
    writeCacheSlot("claude", data);
    return formatLimits(data);
  } finally {
    clearTimeout(timer);
    releaseFetchLock(lock);
  }
}

// --- Codex rate limits ---

function readCodexCredentials() {
  try {
    const authPath = join(homedir(), ".codex", "auth.json");
    const parsed = JSON.parse(readFileSync(authPath, "utf-8"));
    const { id_token, access_token, refresh_token, account_id } = parsed.tokens || {};
    if (!account_id) return null;
    const clientId = getCodexClientId(id_token);
    if (!clientId) return null;
    return { accessToken: access_token, refreshToken: refresh_token, accountId: account_id, clientId };
  } catch {
    return null;
  }
}

function writeBackCodexCredentials(creds, refreshed) {
  try {
    const authPath = join(homedir(), ".codex", "auth.json");
    const parsed = JSON.parse(readFileSync(authPath, "utf-8"));
    parsed.tokens.access_token = refreshed.accessToken;
    parsed.tokens.refresh_token = refreshed.refreshToken;
    const tmpPath = authPath + ".tmp";
    writeFileSync(tmpPath, JSON.stringify(parsed, null, 2), { mode: 0o600 });
    renameSync(tmpPath, authPath);
  } catch {}
}

async function refreshCodexToken(refreshTok, clientId, signal) {
  try {
    const resp = await fetch("https://auth.openai.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: clientId,
        refresh_token: refreshTok,
        scope: "openid profile email",
      }).toString(),
      signal,
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const accessToken = data.access_token;
    if (!accessToken) return null;
    return { accessToken, refreshToken: data.refresh_token || null };
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
    if (resp.status === 429) return { rateLimited: true };
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

async function renderCodexData() {
  if (!existsSync(CODEX_FLAG_FILE)) return { kind: "none" };

  const cached = readCacheSlot("codex");
  if (cached) {
    if (cached.error) {
      if (cached.data) return { kind: "data", ...cached.data };
      return { kind: "error", message: formatErrorIndicator(cached) };
    }
    return { kind: "data", ...cached.data };
  }

  const lock = acquireFetchLock("codex");
  if (!lock) {
    try {
      const prev = normalizeCacheEntry(readFullCache().codex);
      if (prev.data) return { kind: "data", ...prev.data };
    } catch {}
    return { kind: "none" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

  try {
    const creds = readCodexCredentials();
    if (!creds) return { kind: "none" };

    let token = creds.accessToken;
    let result = await fetchCodexUsage(token, creds.accountId, controller.signal);

    if (result?.unauthorized) {
      const refreshed = await refreshCodexToken(creds.refreshToken, creds.clientId, controller.signal);
      if (!refreshed) return { kind: "error", message: cacheError("codex", "generic") };
      token = refreshed.accessToken;
      if (refreshed.refreshToken) writeBackCodexCredentials(creds, refreshed);
      result = await fetchCodexUsage(token, creds.accountId, controller.signal);
    }

    if (result?.unauthorized) return { kind: "error", message: cacheError("codex", "auth") };
    if (result?.rateLimited) return { kind: "error", message: cacheError("codex", "rateLimit", readBackoffState("codex") + 1) };

    if (result) {
      writeCacheSlot("codex", result);
      return { kind: "data", ...result };
    }

    return { kind: "error", message: cacheError("codex", "generic") };
  } catch {
    return { kind: "error", message: cacheError("codex", "generic") };
  } finally {
    clearTimeout(timer);
    releaseFetchLock(lock);
  }
}

// --- coral backend ---

// Production coordinator metadata lives at `~/.coral/run/coordinator.json`
// (per `src/infra/path/coordinator.ts`). The legacy `~/.claude/coral/installations/`
// tree no longer carries `backend.json` after the socket-as-lock rewrite —
// only stale `backend.lock` orphans linger there. The statusline is gated to
// the prod flavor by `hud-auto-update.mjs`, so we read prod's runDir directly.
function resolveBackendInfoPath() {
  const infoPath = join(homedir(), ".coral", "run", "coordinator.json");
  try {
    const info = JSON.parse(readFileSync(infoPath, "utf-8"));
    if (!info?.pid) return null;
    try { process.kill(info.pid, 0); } catch { return null; }
    return infoPath;
  } catch {
    return null;
  }
}

// Resolved dynamically on each cache-miss (not cached at module load)
const REEF_INFO_PATH = join(homedir(), ".claude", "coral", "reef.json");

function readReefInfo() {
  try {
    const info = JSON.parse(readFileSync(REEF_INFO_PATH, "utf-8"));
    return info?.url ? info : null;
  } catch {
    return null;
  }
}

async function renderCoralLine() {
  // Migrate: remove legacy backend slot from shared cache
  try {
    const shared = readFullCache();
    if (shared.backend) { delete shared.backend; writeFullCache(shared); }
  } catch {}

  const cached = readBackendSlot();
  if (cached) return cached.line;

  const backendInfoPath = resolveBackendInfoPath();
  if (!backendInfoPath) return null;

  let info;
  try {
    info = JSON.parse(readFileSync(backendInfoPath, "utf-8"));
    if (!info?.port || !info?.token) return null;
  } catch {
    return null;
  }

  const lock = acquireFetchLock("backend");
  if (!lock) {
    return readStaleBackendLine();
  }

  try {
    const resp = await fetch(`http://127.0.0.1:${info.port}/health`, {
      headers: { "x-coral-backend-token": info.token },
      signal: AbortSignal.timeout(CORAL_HEALTH_TIMEOUT_MS),
    });
    if (!resp.ok) {
      const line = `${DIM}coral${RESET}`;
      writeBackendSlot(line, false);
      return line;
    }
    const data = await resp.json();
    const parts = [`\x1b[38;2;255;133;89mcoral${RESET}`];
    if (data.active > 0) parts.push(`${MAGENTA}⚙ ${data.active}${RESET}`);
    if (data.queueDepth > 0) parts.push(`${MAGENTA}⏳ ${data.queueDepth}${RESET}`);
    if (data.liveDiscuss > 0) parts.push(`${MAGENTA}💬 ${data.liveDiscuss}${RESET}`);

    const reefInfo = readReefInfo();
    if (reefInfo) {
      try {
        const reefResp = await fetch(`${reefInfo.url}/health`, { signal: AbortSignal.timeout(CORAL_HEALTH_TIMEOUT_MS) });
        if (reefResp.ok) parts.push(`\x1b]8;;${reefInfo.url}\x07reef\x1b]8;;\x07`);
      } catch {}
    }

    const line = parts.join(" ");
    writeBackendSlot(line, true);
    return line;
  } catch {
    const line = `${DIM}coral${RESET}`;
    writeBackendSlot(line, false);
    return line;
  } finally {
    releaseFetchLock(lock);
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
  const [limits, rawCodexData, coralLine] = await Promise.all([
    safe(renderLimits()),
    safe(renderCodexData()),
    safe(renderCoralLine()),
  ]);
  const codexData = rawCodexData ?? { kind: "none" };

  // Column alignment: model name + limits (up to second |)
  const claudeModel = renderModel(input);
  const envModel = process.env.CORAL_CODEX_MODEL || "gpt-5.4";
  let col1Claude, col1Codex, col2Claude, col2Codex;
  const addonTier = codexData.additionalLabel?.toLowerCase() || null;
  const hasAddon = addonTier ? envModel.toLowerCase().endsWith(`-${addonTier}`) : false;

  if (codexData.kind === "data") {
    const codexModel = hasAddon ? envModel.slice(0, envModel.lastIndexOf("-")) : envModel;

    [col1Claude, col1Codex] = alignColumns(claudeModel, codexModel);
    const codexLimits = formatLimits(codexData.codex);
    [col2Claude, col2Codex] = alignColumns(limits, codexLimits);
  } else {
    col1Claude = claudeModel;
    col2Claude = limits;
    col1Codex = null;
    col2Codex = null;
  }

  // Parse transcript once for activity + last user message
  const transcript = parseTranscript(input);

  // Line 1: Claude
  const line1 = [
    col1Claude,
    col2Claude,
    renderContext(input),
    renderSession(input),
    renderGitBranch(input),
    transcript.activity,
  ].filter(Boolean);

  let output = line1.join(SEP);

  // Line 2: Codex
  if (codexData.kind === "data") {
    const sparkLabel = hasAddon ? `${GREEN}${codexData.additionalLabel}${RESET}` : codexData.additionalLabel;
    const sparkLimits = codexData.spark ? formatLimits(codexData.spark) : null;
    const sparkStr = sparkLimits ? `${sparkLabel} ${sparkLimits}` : null;
    if (col1Codex) col1Codex = hasAddon ? col1Codex : `${GREEN}${col1Codex}${RESET}`;
    const line2 = [
      col1Codex,
      col2Codex,
      sparkStr,
    ].filter(Boolean);
    if (line2.length > 0) {
      output += "\n" + line2.join(SEP);
    }
  } else if (codexData.kind === "error") {
    output += "\n" + codexData.message;
  }

  // Line 3: Coral backend + right-aligned last user input
  if (coralLine) {
    const targetWidth = visualLen(line1.join(SEP));
    const lastMsg = transcript.lastUserMessage?.replace(/[\n\r]+/g, " ");
    let coralFinal = coralLine;
    if (lastMsg && targetWidth > 0) {
      const coralLen = visualLen(coralLine);
      const maxMsg = Math.min(40, targetWidth - coralLen - 3);
      if (maxMsg > 8) {
        const truncated = lastMsg.length > maxMsg ? lastMsg.slice(0, maxMsg - 1) + "\u2026" : lastMsg;
        const gap = targetWidth - coralLen - truncated.length;
        if (gap > 0) {
          coralFinal = coralLine + " ".repeat(gap) + DIM + truncated + RESET;
        }
      }
    }
    output += "\n" + coralFinal;
  }

  // Write session state
  const sessionId = input.session_id;
  if (sessionId && transcript._session) {
    const ctx = input.context_window?.used_percentage ?? null;
    writeSession(sessionId, { ctx, ...transcript._session });
  }

  output = output
    .split("\n")
    .map(line => line.replace(/ +$/, m => "\u00A0".repeat(m.length)))
    .join("\n");
  process.stdout.write(output);
}

main().catch(() => process.stdout.write(""));
