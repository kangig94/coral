#!/usr/bin/env node

// Coral HUD Statusline
// Line 1: model │ limits │ ctx │ session │ skill
// Line 2: codex model │ codex limits │ codex credits

import {
  readFileSync,
  readdirSync,
  existsSync,
  writeFileSync,
  mkdirSync,
  openSync,
  fstatSync,
  statSync,
  readSync,
  closeSync,
  renameSync,
  unlinkSync,
} from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { execSync } from 'child_process';
import { createHash } from 'crypto';
import { pathToFileURL } from 'url';

// Claude's config dir, honoring CLAUDE_CONFIG_DIR (set when launching `claude`,
// inherited by this statusLine subprocess). Falls back to ~/.claude.
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');

const SEP = ' \u2502 ';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const CYAN = '\x1b[36m';
const MAGENTA = '\x1b[35m';
const CODEX_USER_AGENT = 'codex_cli_rs/0.117.0';

function getCodexClientId(idToken) {
  try {
    const payload = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString());
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
  process.stdin.setEncoding('utf8');
  try {
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
    }
    const raw = chunks.join('');
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
    const opts = { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], cwd, timeout: 2000 };
    const branch =
      execSync('git branch --show-current', opts).trim() || execSync('git rev-parse --short HEAD', opts).trim();
    if (!branch) return null;
    const dirty = execSync('git status --porcelain', opts).trim() ? `${YELLOW}*${RESET}` : '';
    return `${CYAN}⎇ ${branch}${RESET}${dirty}`;
  } catch {
    return null;
  }
}

// --- elements ---

function renderModel(input) {
  if (!input.model) return null;
  const name = input.model.display_name || input.model.id || '';
  return name
    .toLowerCase()
    .replace(/^claude\s+/, '')
    .replace(/\(200k\s+context\)/i, '')
    .replace(/\((\d+[km])\s+context\)/i, '$1')
    .replace(/\s+$/, '');
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
        durationStr = `${hr}h${remMin > 0 ? remMin + 'm' : ''}`;
      }
    }
  }

  const parts = [costStr, durationStr].filter(Boolean);
  return parts.length > 0 ? parts.join(' ') : null;
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
    fd = openSync(transcriptPath, 'r');
    const { size } = fstatSync(fd);
    const readSize = Math.min(size, 512 * 1024);
    const buf = Buffer.alloc(readSize);
    readSync(fd, buf, 0, readSize, size - readSize);
    const lines = buf.toString('utf-8').split('\n');
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
    if (line.includes('command-message')) {
      try {
        const entry = JSON.parse(line);
        const content = entry?.message?.content;
        if (typeof content === 'string') {
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
          if (
            block.type === 'tool_use' &&
            (block.name === 'Skill' || block.name === 'proxy_Skill') &&
            block.input?.skill
          ) {
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
        if (block.type === 'tool_use' && (block.name === 'Task' || block.name === 'proxy_Task') && block.id) {
          agentMap.set(block.id, {
            subagent_type: block.input?.subagent_type || 'unknown',
            startTime: ts,
          });
        }
        if (block.type === 'tool_result' && block.tool_use_id) {
          agentMap.delete(block.tool_use_id);
        }
      }
    } catch {}
  }
  const now = Date.now();
  return Array.from(agentMap.values()).filter((a) => !a.startTime || now - a.startTime.getTime() < STALE_AGENT_MS);
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
  if (
    /<task-notification>|<local-command|^Base directory for this skill:|^This session is being continued from|^Stop hook feedback:/i.test(
      raw,
    )
  )
    return null;
  // Strip remaining XML tags (system-reminder etc.) and noise markers
  const clean = raw.replace(/<[^>]+>/g, '').trim();
  if (!clean || /^\[Request interrupted|^\[Tool cancelled|^\[User cancelled/i.test(clean)) return null;
  return clean;
}

function parseLastUserMessage(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.includes('"user"')) continue;
    try {
      const entry = JSON.parse(line);
      if (entry?.type !== 'human' && entry?.message?.role !== 'user') continue;
      const content = entry?.message?.content;
      if (typeof content === 'string') {
        const text = extractUserText(content);
        if (text) return text;
      }
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text' && typeof block.text === 'string') {
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
  return `${DIM}${Object.entries(counts)
    .map(([t, c]) => (c > 1 ? `${t}×${c}` : t))
    .join(' ')}${RESET}`;
}

function renderActivityStr(agents, activity) {
  const agentList = Array.isArray(agents) ? agents : Object.values(agents || {});
  if (agentList.length > 0) return formatAgentCounts(agentList);
  if (activity?.name && activity?.ts && Date.now() - activity.ts < ACTIVITY_TTL_MS) {
    return `${CYAN}${activity.name}${RESET}`;
  }
  return null;
}

function parseTranscript(input) {
  const sessionId = input.session_id;
  const transcriptPath = input.transcript_path;

  let transcriptSize = 0;
  try {
    transcriptSize = statSync(transcriptPath).size;
  } catch {}

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
  if (!lines)
    return {
      activity: null,
      lastUserMessage: null,
      _session: { activity: null, agents: {}, prompt: null, transcriptSize },
    };

  const running = parseRunningAgents(lines);
  const skill = parseLastSkill(lines);
  const prompt = parseLastUserMessage(lines);

  const agentsMap = {};
  running.forEach((a, i) => {
    agentsMap[i] = { subagent_type: a.subagent_type, ts: a.startTime?.getTime() || Date.now() };
  });

  const now = Date.now();
  const activity = skill
    ? { name: skill, ts: cached?.activity?.name === skill ? cached.activity.ts : now }
    : cached?.activity || null;

  return {
    activity: renderActivityStr(running, activity),
    lastUserMessage: prompt,
    _session: { activity, agents: agentsMap, prompt, transcriptSize },
  };
}

// --- cache ---

const CACHE_DIR = join(CLAUDE_DIR, 'hud');
const CACHE_FILE = join(CACHE_DIR, '.coral-cache.json');
const BACKEND_CACHE_FILE = join(CACHE_DIR, '.coral-backend-cache.json');
const CODEX_FLAG_FILE = join(CACHE_DIR, '.coral-codex-enabled');
const CACHE_TTL_MS = 180_000;
const CACHE_FAIL_TTL_MS = 30_000;
const RATE_LIMIT_BASE_MS = 120_000;
const RATE_LIMIT_MAX_MS = 600_000;
const API_TIMEOUT_MS = 5_000;
const LOCK_STALE_MS = 10_000;
const CORAL_HEALTH_TTL_MS = 5_000;
const CORAL_HEALTH_TIMEOUT_MS = 3_000;

// --- session state ---

const SESSIONS_FILE = join(CACHE_DIR, '.coral-sessions.json');
let _sessionsCache = null;

function readSessions() {
  if (_sessionsCache) return _sessionsCache;
  try {
    _sessionsCache = JSON.parse(readFileSync(SESSIONS_FILE, 'utf-8'));
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
    return JSON.parse(readFileSync(CACHE_FILE, 'utf-8'));
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
    const raw = readFileSync(lockPath, 'utf-8');
    let isStale = true;
    try {
      const lockData = JSON.parse(raw);
      isStale = Date.now() - lockData.ts > LOCK_STALE_MS;
    } catch {} // corrupt/empty JSON → treat as stale
    if (!isStale) return null;
    try {
      unlinkSync(lockPath);
    } catch {}
  } catch {} // ENOENT → no lock exists
  try {
    writeFileSync(lockPath, JSON.stringify({ ts: Date.now() }), { flag: 'wx', mode: 0o600 });
    return lockPath;
  } catch {
    return null;
  }
}

function releaseFetchLock(lockPath) {
  try {
    unlinkSync(lockPath);
  } catch {}
}

function readBackendSlot() {
  try {
    const raw = JSON.parse(readFileSync(BACKEND_CACHE_FILE, 'utf-8'));
    if (!raw || !Number.isFinite(raw.ts)) return null;
    if (Date.now() - raw.ts > CORAL_HEALTH_TTL_MS) return null;
    return normalizeBackendSlot(raw);
  } catch {
    return null;
  }
}

function normalizeBackendSlot(raw) {
  if (!raw || typeof raw.line !== 'string') return null;
  return {
    line: raw.line,
    indicator: typeof raw.indicator === 'string' && raw.indicator.length > 0 ? raw.indicator : null,
  };
}

function readStaleBackendSlot() {
  try {
    return normalizeBackendSlot(JSON.parse(readFileSync(BACKEND_CACHE_FILE, 'utf-8')));
  } catch {
    return null;
  }
}

function writeBackendSlot(slot, online) {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    const tmp = `${BACKEND_CACHE_FILE}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify({ ts: Date.now(), ...slot, online }), { mode: 0o600 });
    renameSync(tmp, BACKEND_CACHE_FILE);
  } catch {}
}

// --- Claude rate limits ---

function getClaudeAccessToken() {
  // macOS Keychain
  if (process.platform === 'darwin') {
    try {
      const raw = execSync('/usr/bin/security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null', {
        encoding: 'utf-8',
        timeout: 2000,
      }).trim();
      if (raw) {
        const parsed = JSON.parse(raw);
        return (parsed.claudeAiOauth || parsed).accessToken || null;
      }
    } catch {}
  }
  // File fallback
  try {
    const credPath = join(CLAUDE_DIR, '.credentials.json');
    const parsed = JSON.parse(readFileSync(credPath, 'utf-8'));
    return (parsed.claudeAiOauth || parsed).accessToken || null;
  } catch {
    return null;
  }
}

async function fetchUsage(accessToken, signal) {
  try {
    const resp = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'Content-Type': 'application/json',
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
  if (mode === 'wk' && totalHr >= 24) {
    return `${(totalHr / 24).toFixed(1)}d`;
  }
  const mm = totalMin % 60;
  return `${totalHr}:${String(mm).padStart(2, '0')}`;
}

function formatWindow(label, val, resetsAt, mode, dimLabel = false) {
  if (val == null) return null;
  const pct = clampPct(val);
  const reset = formatResetTime(resetsAt, mode);
  const resetStr = reset ? ` ${DIM}(${reset})${RESET}` : '';
  const prefix = dimLabel ? `${DIM}${label}:${RESET}` : `${label}:`;
  return `${prefix}${colorPct(pct)}${resetStr}`;
}

function fmtUsd(n) {
  if (n >= 100 || Number.isInteger(n)) return `$${Math.round(n)}`;
  if (n >= 1) return `$${n.toFixed(1)}`;
  return `$${n.toFixed(2)}`;
}

// Enterprise/extra-usage plans replace the 5h/weekly windows with a monthly
// dollar cap (`extra_usage`). Amounts are integer minor units scaled by
// `decimal_places`; utilization is derived from used/limit (the API leaves the
// `utilization` field null at zero usage).
function parseExtraUsage(eu) {
  if (!eu || !eu.is_enabled || eu.disabled_reason) return null;
  if (typeof eu.monthly_limit !== 'number' || eu.monthly_limit <= 0) return null;
  const div = Math.pow(10, typeof eu.decimal_places === 'number' ? eu.decimal_places : 2);
  const limit = eu.monthly_limit / div;
  const used = (typeof eu.used_credits === 'number' ? eu.used_credits : 0) / div;
  return { used, limit, pct: (used / limit) * 100 };
}

function formatExtraUsage(eu) {
  if (!eu) return null;
  return `${DIM}mo:${RESET}${colorPct(clampPct(eu.pct))} ${DIM}(${fmtUsd(eu.used)}/${fmtUsd(eu.limit)})${RESET}`;
}

function parseCodexCredits(credits) {
  if (!credits) return null;
  return {
    hasCredits: Boolean(credits.has_credits),
    unlimited: Boolean(credits.unlimited),
    overageLimitReached: Boolean(credits.overage_limit_reached),
    balance: typeof credits.balance === 'string' ? credits.balance : null,
  };
}

function parseCodexSpendControl(spendControl) {
  if (!spendControl) return null;
  return {
    reached: Boolean(spendControl.reached),
    individualLimit: spendControl.individual_limit ?? null,
  };
}

function formatCreditBalanceUsd(raw, showZero) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const numeric = Number(trimmed);
  if (Number.isFinite(numeric)) {
    if (numeric > 0) return fmtUsd(numeric / 25);
    if (showZero && numeric === 0) return fmtUsd(0);
    return null;
  }

  return null;
}

function formatCreditValueUsd(value, showZero = false) {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return null;
  if (numeric > 0) return fmtUsd(numeric / 25);
  return showZero && numeric === 0 ? fmtUsd(0) : null;
}

function formatCodexCreditState(credits, spendControl, showZero = false) {
  if (!credits || !credits.hasCredits) return null;
  const parts = [];
  if (credits.unlimited) {
    parts.push(`${DIM}cr:${RESET}${GREEN}\u221e${RESET}`);
  } else {
    const balance = formatCreditBalanceUsd(credits.balance, showZero || spendControl?.reached);
    if (balance) {
      const color = spendControl?.reached || balance === '$0' ? RED : GREEN;
      parts.push(`${DIM}cr:${RESET}${color}${balance}${RESET}`);
    }
  }

  const individualLimit = formatCreditValueUsd(spendControl?.individualLimit);
  if (individualLimit) {
    const hit = spendControl?.reached ? ` ${RED}hit${RESET}` : '';
    parts.push(`${DIM}cap:${RESET}${individualLimit}${hit}`);
  }

  return parts.length > 0 ? parts.join(' ') : null;
}

function formatLimits(data) {
  if (!data) return null;
  const windows = [
    formatWindow('5h', data.fiveHour, data.fiveHourResetsAt, '5h'),
    formatWindow('wk', data.weekly, data.weeklyResetsAt, 'wk', true),
  ].filter(Boolean);
  const parts = [...windows, formatExtraUsage(data.extraUsage)].filter(Boolean);
  return parts.length > 0 ? parts.join(' ') : null;
}

function formatRemainingTime(cache) {
  const remaining = cache.ts + getCacheTtlMs(cache) - Date.now();
  const minutes = Math.max(1, Math.ceil(remaining / 60000));
  return `${minutes}m`;
}

function formatErrorIndicator(cache) {
  switch (cache.errorKind) {
    case 'rateLimit':
      return `${DIM}throttled: refreshes in ${formatRemainingTime(cache)}${RESET}`;
    case 'auth':
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
  const cached = readCacheSlot('claude');
  if (cached) {
    if (cached.error) {
      if (cached.data) return formatLimits(cached.data);
      return formatErrorIndicator(cached);
    }
    return formatLimits(cached.data);
  }

  const lock = acquireFetchLock('claude');
  if (!lock) return readStaleCacheData('claude');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  try {
    const token = getClaudeAccessToken();
    if (!token) return null;

    const resp = await fetchUsage(token, controller.signal);
    if (resp?.unauthorized) return cacheError('claude', 'auth');
    if (resp?.rateLimited) return cacheError('claude', 'rateLimit', readBackoffState('claude') + 1);
    if (!resp) return cacheError('claude', 'generic');

    const data = {
      fiveHour: resp.five_hour?.utilization,
      weekly: resp.seven_day?.utilization,
      fiveHourResetsAt: resp.five_hour?.resets_at || null,
      weeklyResetsAt: resp.seven_day?.resets_at || null,
      extraUsage: parseExtraUsage(resp.extra_usage),
    };
    writeCacheSlot('claude', data);
    return formatLimits(data);
  } finally {
    clearTimeout(timer);
    releaseFetchLock(lock);
  }
}

// --- Codex rate limits ---

function readCodexCredentials() {
  try {
    const authPath = join(homedir(), '.codex', 'auth.json');
    const parsed = JSON.parse(readFileSync(authPath, 'utf-8'));
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
    const authPath = join(homedir(), '.codex', 'auth.json');
    const parsed = JSON.parse(readFileSync(authPath, 'utf-8'));
    parsed.tokens.access_token = refreshed.accessToken;
    parsed.tokens.refresh_token = refreshed.refreshToken;
    const tmpPath = authPath + '.tmp';
    writeFileSync(tmpPath, JSON.stringify(parsed, null, 2), { mode: 0o600 });
    renameSync(tmpPath, authPath);
  } catch {}
}

async function refreshCodexToken(refreshTok, clientId, signal) {
  try {
    const resp = await fetch('https://auth.openai.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: clientId,
        refresh_token: refreshTok,
        scope: 'openid profile email',
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
    fiveHour: pri.pct,
    weekly: sec.pct,
    fiveHourResetsAt: pri.resetsAt,
    weeklyResetsAt: sec.resetsAt,
  };
}

function attachCodexAccountState(limits, body) {
  const credits = parseCodexCredits(body.credits);
  const spendControl = parseCodexSpendControl(body.spend_control);
  if (!limits && !credits && !spendControl) return null;
  return {
    ...(limits || {}),
    ...(credits ? { credits } : {}),
    ...(spendControl ? { spendControl } : {}),
  };
}

async function fetchCodexUsage(accessToken, accountId, signal) {
  try {
    const resp = await fetch('https://chatgpt.com/backend-api/wham/usage', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'chatgpt-account-id': accountId,
        'User-Agent': CODEX_USER_AGENT,
        originator: 'codex_cli_rs',
      },
      signal,
    });
    if (resp.status === 401) return { unauthorized: true };
    if (resp.status === 429) return { rateLimited: true };
    if (!resp.ok) return null;
    const body = await resp.json();

    const codex = attachCodexAccountState(parseLimitsFromRl(body.rate_limit), body);

    return { codex };
  } catch {
    return null;
  }
}

async function renderCodexData() {
  if (!existsSync(CODEX_FLAG_FILE)) return { kind: 'none' };

  const cached = readCacheSlot('codex');
  if (cached) {
    if (cached.error) {
      if (cached.data) return { kind: 'data', ...cached.data };
      return { kind: 'error', message: formatErrorIndicator(cached) };
    }
    return { kind: 'data', ...cached.data };
  }

  const lock = acquireFetchLock('codex');
  if (!lock) {
    try {
      const prev = normalizeCacheEntry(readFullCache().codex);
      if (prev.data) return { kind: 'data', ...prev.data };
    } catch {}
    return { kind: 'none' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

  try {
    const creds = readCodexCredentials();
    if (!creds) return { kind: 'none' };

    let token = creds.accessToken;
    let result = await fetchCodexUsage(token, creds.accountId, controller.signal);

    if (result?.unauthorized) {
      const refreshed = await refreshCodexToken(creds.refreshToken, creds.clientId, controller.signal);
      if (!refreshed) return { kind: 'error', message: cacheError('codex', 'generic') };
      token = refreshed.accessToken;
      if (refreshed.refreshToken) writeBackCodexCredentials(creds, refreshed);
      result = await fetchCodexUsage(token, creds.accountId, controller.signal);
    }

    if (result?.unauthorized) return { kind: 'error', message: cacheError('codex', 'auth') };
    if (result?.rateLimited)
      return { kind: 'error', message: cacheError('codex', 'rateLimit', readBackoffState('codex') + 1) };

    if (result) {
      writeCacheSlot('codex', result);
      return { kind: 'data', ...result };
    }

    return { kind: 'error', message: cacheError('codex', 'generic') };
  } catch {
    return { kind: 'error', message: cacheError('codex', 'generic') };
  } finally {
    clearTimeout(timer);
    releaseFetchLock(lock);
  }
}

// --- coral backend ---

// Coordinator state is partitioned per Claude config dir: a non-default
// CLAUDE_CONFIG_DIR is a distinct daemon registered under
// `~/.coral/by-config/<slot>/run/`, while the default `~/.claude` keeps the
// unpartitioned `~/.coral/run/`. Mirrors `claudeConfigSlot`/`coralStateRoot`
// in `src/infra/path/root.ts` so the HUD reads the same backend the CLI does.
function coralStateRoot() {
  const home = homedir();
  if (CLAUDE_DIR === join(home, '.claude')) return join(home, '.coral');
  const slot = createHash('sha256').update(CLAUDE_DIR).digest('hex').slice(0, 8);
  return join(home, '.coral', 'by-config', slot);
}

// The statusline is gated to the prod flavor by `hud-auto-update.mjs`, so we
// read prod's runDir directly.
function resolveBackendInfoPath() {
  const infoPath = join(coralStateRoot(), 'run', 'coordinator.json');
  try {
    const info = JSON.parse(readFileSync(infoPath, 'utf-8'));
    if (!info?.pid) return null;
    try {
      process.kill(info.pid, 0);
    } catch {
      return null;
    }
    return infoPath;
  } catch {
    return null;
  }
}

// Resolved dynamically on each cache-miss (not cached at module load)
const REEF_INFO_PATH = join(CLAUDE_DIR, 'coral', 'reef.json');

function readReefInfo() {
  try {
    const info = JSON.parse(readFileSync(REEF_INFO_PATH, 'utf-8'));
    return info?.url ? info : null;
  } catch {
    return null;
  }
}

export function renderTextProjectionIndicator(state) {
  if (state === 'fetching') return `${YELLOW}fetching${RESET}`;
  if (state === 'reindexing') return `${YELLOW}reindexing${RESET}`;
  return null;
}

export function composeCoralThirdLine(coralLine, rightIndicator, lastUserMessage, targetWidth) {
  let right = rightIndicator;
  if (!right && lastUserMessage && targetWidth > 0) {
    const maxMsg = Math.min(40, targetWidth - visualLen(coralLine) - 3);
    if (maxMsg > 8) {
      const oneLineMessage = lastUserMessage.replace(/[\n\r]+/g, ' ');
      const truncated =
        oneLineMessage.length > maxMsg ? oneLineMessage.slice(0, maxMsg - 1) + '\u2026' : oneLineMessage;
      right = DIM + truncated + RESET;
    }
  }

  if (!right) return coralLine;

  const gap = targetWidth - visualLen(coralLine) - visualLen(right);
  if (gap > 0) {
    return coralLine + ' '.repeat(gap) + right;
  }
  return `${coralLine} ${right}`;
}

async function renderCoralLine() {
  // Migrate: remove retired backend slot from shared cache
  try {
    const shared = readFullCache();
    if (shared.backend) {
      delete shared.backend;
      writeFullCache(shared);
    }
  } catch {}

  const cached = readBackendSlot();
  if (cached) return cached;

  const backendInfoPath = resolveBackendInfoPath();
  if (!backendInfoPath) return null;

  let info;
  try {
    info = JSON.parse(readFileSync(backendInfoPath, 'utf-8'));
    if (!info?.port || !info?.bootToken) return null;
  } catch {
    return null;
  }

  const lock = acquireFetchLock('backend');
  if (!lock) {
    return readStaleBackendSlot();
  }

  try {
    // The bare `/health` ping carries no job counts; the live snapshot
    // (active/queueDepth/liveDiscuss/textProjectionState) lives behind
    // `?detailed=1`, gated by the boot token — mirror `coral-cli backend status`,
    // including its discovered advertise host (e.g. `::1`), not a hardcoded loopback.
    const resp = await fetch(`http://${info.host ?? '127.0.0.1'}:${info.port}/health?detailed=1`, {
      headers: { 'X-Coral-Boot-Token': info.bootToken },
      signal: AbortSignal.timeout(CORAL_HEALTH_TIMEOUT_MS),
    });
    if (!resp.ok) {
      const slot = { line: `${DIM}coral${RESET}`, indicator: null };
      writeBackendSlot(slot, false);
      return slot;
    }
    const data = await resp.json();
    const parts = [`\x1b[38;2;255;133;89mcoral${RESET}`];
    if (data.active > 0) parts.push(`${MAGENTA}⚙ ${data.active}${RESET}`);
    if (data.queueDepth > 0) parts.push(`${MAGENTA}⏳ ${data.queueDepth}${RESET}`);
    if (data.liveDiscuss > 0) parts.push(`${MAGENTA}💬 ${data.liveDiscuss}${RESET}`);
    const indicator = renderTextProjectionIndicator(data.textProjectionState);

    const reefInfo = readReefInfo();
    if (reefInfo) {
      try {
        const reefResp = await fetch(`${reefInfo.url}/health`, {
          signal: AbortSignal.timeout(CORAL_HEALTH_TIMEOUT_MS),
        });
        if (reefResp.ok) parts.push(`\x1b]8;;${reefInfo.url}\x07reef\x1b]8;;\x07`);
      } catch {}
    }

    const slot = { line: parts.join(' '), indicator };
    writeBackendSlot(slot, true);
    return slot;
  } catch {
    const slot = { line: `${DIM}coral${RESET}`, indicator: null };
    writeBackendSlot(slot, false);
    return slot;
  } finally {
    releaseFetchLock(lock);
  }
}

// --- main ---

function visualLen(str) {
  return str.replace(/\x1b\[[0-9;]*m/g, '').length;
}

function padVisual(str, len) {
  const pad = len - visualLen(str);
  return pad > 0 ? str + ' '.repeat(pad) : str;
}

function alignColumns(a, b) {
  if (!a || !b) return [a, b];
  const w = Math.max(visualLen(a), visualLen(b));
  return [padVisual(a, w), padVisual(b, w)];
}

async function main() {
  const input = await readStdin();
  if (!input) {
    process.stdout.write('');
    return;
  }

  const safe = (p) => p.catch(() => null);
  const [limits, rawCodexData, coralSlot] = await Promise.all([
    safe(renderLimits()),
    safe(renderCodexData()),
    safe(renderCoralLine()),
  ]);
  const codexData = rawCodexData ?? { kind: 'none' };

  // Column alignment: model name + limits (up to second |)
  const claudeModel = renderModel(input);
  const envModel = process.env.CORAL_CODEX_MODEL || 'gpt-5.6-sol';
  let col1Claude, col1Codex, col2Claude, col2Codex;
  let codexCreditStr = null;

  if (codexData.kind === 'data') {
    [col1Claude, col1Codex] = alignColumns(claudeModel, envModel);
    const codexLimits = formatLimits(codexData.codex);
    codexCreditStr = formatCodexCreditState(codexData.codex?.credits, codexData.codex?.spendControl, !codexLimits);
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
  if (codexData.kind === 'data') {
    if (col1Codex) col1Codex = `${GREEN}${col1Codex}${RESET}`;
    const line2 = [col1Codex, col2Codex, codexCreditStr].filter(Boolean);
    if (line2.length > 0) {
      output += '\n' + line2.join(SEP);
    }
  } else if (codexData.kind === 'error') {
    output += '\n' + codexData.message;
  }

  // Line 3: Coral backend + right-aligned last user input
  if (coralSlot) {
    const coralLine = typeof coralSlot === 'string' ? coralSlot : coralSlot.line;
    const rightIndicator = typeof coralSlot === 'string' ? null : coralSlot.indicator;
    const targetWidth = visualLen(line1.join(SEP));
    const coralFinal = composeCoralThirdLine(coralLine, rightIndicator, transcript.lastUserMessage, targetWidth);
    output += '\n' + coralFinal;
  }

  // Write session state
  const sessionId = input.session_id;
  if (sessionId && transcript._session) {
    const ctx = input.context_window?.used_percentage ?? null;
    writeSession(sessionId, { ctx, ...transcript._session });
  }

  output = output
    .split('\n')
    .map((line) => line.replace(/ +$/, (m) => '\u00A0'.repeat(m.length)))
    .join('\n');
  process.stdout.write(output);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => process.stdout.write(''));
}
