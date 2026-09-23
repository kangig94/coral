#!/usr/bin/env node

import {
  readFileSync,
  existsSync,
  writeFileSync,
  mkdirSync,
  openSync,
  fstatSync,
  statSync,
  readdirSync,
  readSync,
  closeSync,
  renameSync,
  unlinkSync,
} from 'fs';
import { dirname, isAbsolute, join, normalize } from 'path';
import { homedir } from 'os';
import { execSync } from 'child_process';
import { createHash } from 'crypto';
import { pathToFileURL } from 'url';

export function codexCacheKey(codexDir) {
  return `codex-${createHash('sha256').update(normalize(codexDir)).digest('hex').slice(0, 12)}`;
}

export function hudCacheFile(cacheDir, key) {
  return key.startsWith('codex-')
    ? join(cacheDir, `.coral-${key}-cache.json`)
    : join(cacheDir, '.coral-cache.json');
}

export function hudFetchLockPath(cacheDir, key) {
  return join(cacheDir, `.coral-${key}.lock`);
}

export function coralBackendInfoPath(homeDir, flavor = 'prod') {
  return join(homeDir, '.coral', 'gen2', flavor === 'dev' ? 'run-dev' : 'run', 'coordinator.json');
}

export function shouldUseClaudeKeychain(explicitConfigDir, platform) {
  return !explicitConfigDir && platform === 'darwin';
}

const EXPLICIT_CLAUDE_CONFIG_DIR =
  typeof process.env.CLAUDE_CONFIG_DIR === 'string' && process.env.CLAUDE_CONFIG_DIR.length > 0;
const CLAUDE_DIR = EXPLICIT_CLAUDE_CONFIG_DIR ? process.env.CLAUDE_CONFIG_DIR : join(homedir(), '.claude');
const CODEX_DIR =
  typeof process.env.CODEX_HOME === 'string' && isAbsolute(process.env.CODEX_HOME)
    ? normalize(process.env.CODEX_HOME)
    : join(homedir(), '.codex');

const CODEX_CACHE_SLOT = codexCacheKey(CODEX_DIR);

const SEP = ' \u2502 ';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const CYAN = '\x1b[36m';
const MAGENTA = '\x1b[35m';
const CODEX_USER_AGENT = 'codex_cli_rs/0.117.0';

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

// `--no-optional-locks` is required rather than preferred: without it `git status` refreshes and
// rewrites `.git/index`, so concurrent renders contend for `.git/index.lock` inside the repository.
// `execSync`'s timeout delivers a signal, and a process blocked in an uninterruptible filesystem
// wait does not take one, so no elapsed bound here establishes that a probe is gone.
function renderGitBranch(input) {
  const cwd = input.cwd || input.workspace?.current_dir || input.workspace?.project_dir;
  if (!cwd) return null;
  const key = gitCacheKey(cwd);
  const entry = readGitCache()[key] || null;
  const now = Date.now();

  if (entry && ((entry.ts <= now && now - entry.ts <= GIT_TTL_MS) || now < entry.backoffUntil))
    return formatGitSegment(entry.value);

  const claim = claimGitProbe(key, now);
  if (claim === null) return formatGitSegment(entry?.value);

  try {
    const value = probeGit(cwd);
    writeGitEntry(key, { ts: Date.now(), value, backoffUntil: 0 });
    return formatGitSegment(value);
  } catch (error) {
    // An answer that there is no repository here will still be true on the next render, so re-asking it
    // at the cadence a branch name needs is what spends a subprocess per render forever.
    if (probeAnswered(error)) {
      writeGitEntry(key, { ts: Date.now(), value: null, backoffUntil: now + GIT_NEGATIVE_TTL_MS });
      return null;
    }
    backOffRepo(key, now);
    return formatGitSegment(entry?.value);
  } finally {
    releaseHudLock(claim);
  }
}

// `status` is the child's own exit code and is a number only when git ran to completion. A spawn that
// never produced a child — EAGAIN under fork pressure, EMFILE, a missing cwd — leaves it null, and
// those are exactly the failures N concurrent renders create. Listing the non-answers instead makes
// every unlisted one default to "answered", which is the wrong direction to be wrong in.
export function probeAnswered(error) {
  return typeof error?.status === 'number';
}

function probeGit(cwd) {
  return parseGitStatus(
    execSync('git --no-optional-locks status --porcelain=v2 --branch', {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
      cwd,
      timeout: GIT_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    }),
  );
}

export function parseGitStatus(out) {
  let head = '';
  let oid = '';
  let dirty = false;
  for (const line of out.split('\n')) {
    if (line.startsWith('# branch.head ')) head = line.slice(14).trim();
    else if (line.startsWith('# branch.oid ')) oid = line.slice(13).trim();
    else if (line.length > 0 && !line.startsWith('#')) dirty = true;
  }
  // A repository with no commits reports `(initial)` as the oid, which names no revision.
  const detached = head === '' || head === '(detached)';
  const branch = detached ? (oid.startsWith('(') ? '' : oid.slice(0, 7)) : head;
  return branch === '' ? null : { branch, dirty };
}

export function formatGitSegment(value) {
  if (!value || typeof value.branch !== 'string' || value.branch === '') return null;
  // `git check-ref-format` rejects refname bytes below \040 and \177, so this value cannot carry terminal controls.
  return `${CYAN}⎇ ${value.branch}${RESET}${value.dirty ? `${YELLOW}*${RESET}` : ''}`;
}

// A hold that outlived its holder must name the repository it was probing, or the render that finds it
// fences its own instead and leaves the stalled one free to be probed again. The holder cannot be
// signalled, so the back-off expiring is the only exit this hold has.
function claimGitProbe(key, now) {
  const lockPath = hudFetchLockPath(CACHE_DIR, GIT_LOCK_KEY);
  const held = readHudLockHold(lockPath);
  if (held !== null) {
    if (holdIsLive(held, now)) return null;
    if (!deleteStaleHudLock(lockPath, held)) return null;
    if (held.key !== null) {
      const claim = claimHudLock(lockPath, held.key, now);
      if (claim) {
        try {
          backOffRepo(held.key, now);
        } finally {
          releaseHudLock(claim);
        }
      }
    }
    return null;
  }
  return claimHudLock(lockPath, key, now);
}

// A record that cannot be read still proves a holder created the file, and its age is the only thing
// it can still say. Reading that as no holder leaves the file in place while `wx` refuses to replace
// it, which is a lock nothing can ever take again.
function readHudLockHold(lockPath) {
  let mtimeMs;
  try {
    mtimeMs = statSync(lockPath).mtimeMs;
  } catch {
    return null;
  }
  try {
    const held = JSON.parse(readFileSync(lockPath, 'utf-8'));
    if (Number.isFinite(held?.ts) && typeof held?.key === 'string' && typeof held?.nonce === 'string') return held;
  } catch {}
  return { ts: mtimeMs, key: null, nonce: null };
}

// A `ts` ahead of `now` is expired: treating a backward clock step as live leaves no exit until the
// skew elapses, while the exclusive create bounds the extra probe it can admit.
export function holdIsLive(held, now) {
  return held.ts <= now && now - held.ts <= LOCK_STALE_MS;
}

function deleteStaleHudLock(lockPath, held) {
  const current = readHudLockHold(lockPath);
  const matches =
    current !== null &&
    (held.nonce !== null ? current.nonce === held.nonce : current.nonce === null && current.ts === held.ts);
  if (!matches) return false;
  deleteHudFile(lockPath);
  return true;
}

// The exclusive create is the whole arbitration, so a stale lock is surrendered by whoever finds it
// and claimed by a later render that finds none. Deleting and creating in one pass instead lets two
// renders each delete the other's fresh claim and both proceed.
function claimHudLock(lockPath, key, now) {
  const nonce = `${process.pid}-${now}-${Math.random().toString(36).slice(2)}`;
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(lockPath, JSON.stringify({ ts: now, key, nonce }), { flag: 'wx', mode: 0o600 });
    return { lockPath, nonce };
  } catch {
    return null;
  }
}

// Releasing by path alone deletes whatever lock is there, including a successor's — and a vanished
// file is not proof the lock is ours either.
function releaseHudLock(claim) {
  const held = readHudLockHold(claim.lockPath);
  if (held === null || held.nonce !== claim.nonce) return;
  deleteHudFile(claim.lockPath);
}

// `ts` dates the last value actually measured, so backing off must not advance it.
function backOffRepo(key, now) {
  const cache = readGitCache();
  const entry = cache[key] || { ts: 0, value: null };
  writeGitCache({ ...cache, [key]: { ...entry, backoffUntil: now + GIT_BACKOFF_MS } });
}

// Another render may have fenced a stalled repository between this one's read and its rename. A
// back-off is that repository's only containment, so it is re-read here and carried forward rather
// than being whatever this writer happened to observe earlier.
function writeGitEntry(key, entry) {
  const cache = readGitCache();
  const now = Date.now();
  const next = { [key]: entry };
  for (const [cached, value] of Object.entries(cache)) {
    if (cached === key) continue;
    const fenced = now < (value?.backoffUntil || 0);
    if (fenced || now - (value?.ts || 0) <= GIT_ENTRY_PRUNE_MS) next[cached] = value;
  }
  writeGitCache(next);
}

function deleteHudFile(path) {
  try {
    unlinkSync(path);
  } catch {}
}

function gitCacheKey(cwd) {
  return createHash('sha256').update(normalize(cwd)).digest('hex').slice(0, 12);
}

function readGitCache() {
  try {
    const raw = JSON.parse(readFileSync(GIT_CACHE_FILE, 'utf-8'));
    return raw !== null && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

function writeGitCache(all) {
  publishJsonAtomically(GIT_CACHE_FILE, all);
}

function publishJsonAtomically(path, value) {
  const tmpPath = `${path}.tmp-${process.pid}`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tmpPath, JSON.stringify(value), { mode: 0o600 });
    renameSync(tmpPath, path);
  } catch {
    deleteHudFile(tmpPath);
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
    if (line.includes('command-message')) {
      try {
        const entry = JSON.parse(line);
        const content = entry?.message?.content;
        if (typeof content === 'string') {
          const m = content.match(/<command-message>([^<]+)<\/command-message>/);
          if (m?.[1]) return stripControlSequences(m[1]);
        }
      } catch {}
    }
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
            return stripControlSequences(block.input.skill);
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
            subagent_type: stripControlSequences(block.input?.subagent_type || 'unknown'),
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

// An escape that survives here is executed on every later render of the session, and is persisted into
// the session cache and replayed after the transcript is gone, so control bytes are removed rather
// than escaped.
export function stripControlSequences(text) {
  /* eslint-disable no-control-regex -- Removing terminal control bytes is the point. */
  return text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x1f\x7f\u0080-\u009f]/g, ' ');
  /* eslint-enable no-control-regex */
}

export function extractUserText(raw) {
  const cmdMatch = raw.match(/<command-name>([^<]+)<\/command-name>/);
  if (cmdMatch) {
    const name = cmdMatch[1].trim();
    const argsMatch = raw.match(/<command-args>([^<]*)<\/command-args>/);
    const args = argsMatch?.[1]?.trim();
    return stripControlSequences(args ? `${name} ${args}` : name);
  }
  if (
    /<task-notification>|<local-command|^Base directory for this skill:|^This session is being continued from|^Stop hook feedback:/i.test(
      raw,
    )
  )
    return null;
  const clean = stripControlSequences(raw.replace(/<[^>]+>/g, '')).trim();
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

export function renderActivityStr(agents, activity) {
  const now = Date.now();
  // A subagent whose completion never lands keeps its entry, and the cached entry stops being rewritten
  // once the transcript size settles, so its own age is the only thing that can retire it.
  const agentList = (Array.isArray(agents) ? agents : Object.values(agents || {})).filter(
    (agent) => !agent.ts || now - agent.ts < STALE_AGENT_MS,
  );
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
const NO_CREDENTIALS_KIND = 'noCredentials';
const RATE_LIMIT_BASE_MS = 120_000;
const RATE_LIMIT_MAX_MS = 600_000;
const API_TIMEOUT_MS = 5_000;
const LOCK_STALE_MS = 10_000;
const CORAL_HEALTH_TTL_MS = 5_000;
const CORAL_HEALTH_TIMEOUT_MS = 3_000;
const GIT_CACHE_FILE = join(CACHE_DIR, '.coral-git-cache.json');
// One lock for every repository, deliberately. Keying it per repository would let N repositories on
// one network mount spawn N concurrent probes, which is the pile-up this segment exists to prevent.
// The cost is that a stalled repository blanks the others' branch slot until its hold goes stale, and
// that is accepted: this segment assists a reader and never gates anything.
const GIT_LOCK_KEY = 'git';
const GIT_TTL_MS = 5_000;
const GIT_TIMEOUT_MS = 1_000;
const GIT_BACKOFF_MS = 600_000;
// A directory that is not a repository, and a git that will not run, stay that way; a branch name is
// the only thing in this segment that can change between two renders.
const GIT_NEGATIVE_TTL_MS = 300_000;
const GIT_ENTRY_PRUNE_MS = 7 * 24 * 60 * 60_000;
const ORPHANED_TEMP_MAX_AGE_MS = 5 * 60 * 1000;
let orphanedTempsSwept = false;

function sweepOldTempFiles(dir, isTempFile) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  const oldest = Date.now() - ORPHANED_TEMP_MAX_AGE_MS;
  for (const entry of entries) {
    if (!entry.isFile() || !isTempFile(entry.name)) continue;
    const path = join(dir, entry.name);
    try {
      if (statSync(path).mtimeMs < oldest) deleteHudFile(path);
    } catch {}
  }
}

// The Codex entry reclaims what an older build could leave: this one never writes `auth.json`, but a
// build that did could be killed mid-write and strand a file holding a live access and refresh token.
function sweepOrphanedTemps() {
  if (orphanedTempsSwept) return;
  orphanedTempsSwept = true;
  sweepOldTempFiles(CACHE_DIR, (name) =>
    /^(?:\.coral-(?:cache|git-cache|sessions|backend-cache)\.json|\.coral-codex-[0-9a-f]{12}-cache\.json)\.tmp-\d+$/u.test(
      name,
    ),
  );
  sweepOldTempFiles(CODEX_DIR, (name) => /^auth\.json\.tmp-\d+$/u.test(name));
}

// --- session state ---

const SESSIONS_FILE = join(CACHE_DIR, '.coral-sessions.json');
let _sessionsCache = null;

function readSessionsFromDisk() {
  try {
    const raw = JSON.parse(readFileSync(SESSIONS_FILE, 'utf-8'));
    return raw !== null && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

function readSessions() {
  if (_sessionsCache) return _sessionsCache;
  try {
    const raw = JSON.parse(readFileSync(SESSIONS_FILE, 'utf-8'));
    _sessionsCache = raw !== null && typeof raw === 'object' ? raw : {};
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
    const existing = readSessions()[sessionId];
    if (existing && existing.ctx === data.ctx && existing.transcriptSize === data.transcriptSize) return;
    // Every open session writes this one file. The rename publishes a whole document but does not make
    // the read-modify-write around it atomic, so the merge has to start from what is on disk now — a
    // snapshot taken when this process started drops every entry written since.
    const all = readSessionsFromDisk();
    all[sessionId] = { ...data, ts: Date.now() };
    const now = Date.now();
    for (const key of Object.keys(all)) {
      if (now - (all[key]?.ts || 0) > SESSION_PRUNE_MS) delete all[key];
    }
    publishJsonAtomically(SESSIONS_FILE, all);
    _sessionsCache = all;
  } catch {}
}

function readFullCache(key) {
  try {
    return JSON.parse(readFileSync(key === undefined ? CACHE_FILE : hudCacheFile(CACHE_DIR, key), 'utf-8'));
  } catch {
    return {};
  }
}

// Readers take no lock, so a reader in another session may open this file at any point during a
// write. Only the rename makes what they open a whole document.
function writeFullCache(all, key) {
  publishJsonAtomically(key === undefined ? CACHE_FILE : hudCacheFile(CACHE_DIR, key), all);
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
  const entry = readFullCache(key)[key];
  if (!entry) return null;
  const cache = normalizeCacheEntry(entry);
  return isFreshCacheEntry(cache) ? cache : null;
}

function writeCacheSlot(key, data, error = false, rateLimit = 0, errorKind = null) {
  const all = readFullCache(key);
  let nextData = data;
  if (error && nextData == null) {
    const existing = normalizeCacheEntry(all[key]);
    if (existing.data != null) nextData = existing.data;
  }
  all[key] = { ts: Date.now(), data: nextData, error, rateLimit, errorKind };
  writeFullCache(all, key);
}

function readBackoffState(key) {
  try {
    const now = Date.now();
    const cache = normalizeCacheEntry(readFullCache(key)[key]);
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
    const cache = normalizeCacheEntry(readFullCache(key)[key]);
    if (cache.data) return formatLimits(cache.data);
    return null;
  } catch {
    return null;
  }
}

function acquireFetchLock(key) {
  const lockPath = hudFetchLockPath(CACHE_DIR, key);
  const now = Date.now();
  const held = readHudLockHold(lockPath);
  if (held !== null) {
    if (!holdIsLive(held, now)) deleteStaleHudLock(lockPath, held);
    return null;
  }
  return claimHudLock(lockPath, key, now);
}

function readBackendSlot() {
  try {
    const raw = JSON.parse(readFileSync(BACKEND_CACHE_FILE, 'utf-8'));
    if (!raw || !Number.isFinite(raw.ts)) return null;
    if (raw.ts > Date.now() || Date.now() - raw.ts > CORAL_HEALTH_TTL_MS) return null;
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

function writeBackendSlot(slot) {
  try {
    publishJsonAtomically(BACKEND_CACHE_FILE, { ts: Date.now(), ...slot });
  } catch {}
}

// --- Claude rate limits ---

function getClaudeAccessToken() {
  // An explicit config directory is an explicit account selection. The shared
  // macOS Keychain item cannot prove it belongs to that directory, so only
  // ambient Claude may use it.
  if (shouldUseClaudeKeychain(EXPLICIT_CLAUDE_CONFIG_DIR, process.platform)) {
    try {
      const raw = execSync('/usr/bin/security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null', {
        encoding: 'utf-8',
        timeout: 2000,
        killSignal: 'SIGKILL',
      }).trim();
      if (raw) {
        const parsed = JSON.parse(raw);
        return (parsed.claudeAiOauth || parsed).accessToken || null;
      }
    } catch {}
  }
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

// Codex bills credits at 25 to the dollar; the usage API reports credits, and the statusline shows
// dollars. Breaking this converts every figure on line 2 by a wrong factor with nothing to notice it.
const CODEX_CREDITS_PER_USD = 25;

function formatCreditBalanceUsd(raw, showZero) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const numeric = Number(trimmed);
  if (Number.isFinite(numeric)) {
    if (numeric > 0) return fmtUsd(numeric / CODEX_CREDITS_PER_USD);
    if (showZero && numeric === 0) return fmtUsd(0);
    return null;
  }

  return null;
}

function formatCreditValueUsd(value, showZero = false) {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return null;
  if (numeric > 0) return fmtUsd(numeric / CODEX_CREDITS_PER_USD);
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

// The two answers a caller can get after an error are not interchangeable: a badge shown over data that
// still renders tells someone their login is broken while it is working.
function cacheError(slot, errorKind, rateLimit = 0) {
  writeCacheSlot(slot, null, true, rateLimit, errorKind);
  const preserved = normalizeCacheEntry(readFullCache(slot)[slot]).data;
  if (preserved != null) return { preserved };
  return { indicator: formatErrorIndicator({ error: true, errorKind, ts: Date.now(), rateLimit }) };
}

function claudeCacheError(errorKind, rateLimit = 0) {
  const outcome = cacheError('claude', errorKind, rateLimit);
  return (outcome.preserved ? formatLimits(outcome.preserved) : null) ?? outcome.indicator;
}

function codexCacheError(errorKind, rateLimit = 0) {
  const outcome = cacheError(CODEX_CACHE_SLOT, errorKind, rateLimit);
  return outcome.preserved ? { kind: 'data', ...outcome.preserved } : { kind: 'error', message: outcome.indicator };
}

async function renderLimits() {
  const cached = readCacheSlot('claude');
  if (cached) {
    if (cached.errorKind === NO_CREDENTIALS_KIND) return null;
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
    // Absence has to be recorded, or a machine that never logged in reaches the credential source on
    // every render — on macOS that is a Keychain subprocess per render.
    if (!token) {
      writeCacheSlot('claude', null, true, 0, NO_CREDENTIALS_KIND);
      return null;
    }

    const resp = await fetchUsage(token, controller.signal);
    if (resp?.unauthorized) return claudeCacheError('auth');
    if (resp?.rateLimited) return claudeCacheError('rateLimit', readBackoffState('claude') + 1);
    if (!resp) return claudeCacheError('generic');

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
    releaseHudLock(lock);
  }
}

// --- Codex rate limits ---

// `auth.json` belongs to the Codex CLI, which refreshes it. This reader takes the access token and
// nothing else: the refresh token is not read, and a statusline may not rotate a credential a process
// it does not coordinate with is holding — two writers of one token means whichever rotates second
// invalidates the other, and the loser is logged out with nothing to say why.
function readCodexCredentials() {
  try {
    const parsed = JSON.parse(readFileSync(join(CODEX_DIR, 'auth.json'), 'utf-8'));
    const { access_token, account_id } = parsed.tokens || {};
    if (!account_id || !access_token) return null;
    return { accessToken: access_token, accountId: account_id };
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

  const cached = readCacheSlot(CODEX_CACHE_SLOT);
  if (cached) {
    if (cached.errorKind === NO_CREDENTIALS_KIND) return { kind: 'none' };
    if (cached.error) {
      if (cached.data) return { kind: 'data', ...cached.data };
      return { kind: 'error', message: formatErrorIndicator(cached) };
    }
    return { kind: 'data', ...cached.data };
  }

  const lock = acquireFetchLock(CODEX_CACHE_SLOT);
  if (!lock) {
    try {
      const prev = normalizeCacheEntry(readFullCache(CODEX_CACHE_SLOT)[CODEX_CACHE_SLOT]);
      if (prev.data) return { kind: 'data', ...prev.data };
    } catch {}
    return { kind: 'none' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

  try {
    const creds = readCodexCredentials();
    if (!creds) {
      writeCacheSlot(CODEX_CACHE_SLOT, null, true, 0, NO_CREDENTIALS_KIND);
      return { kind: 'none' };
    }

    const result = await fetchCodexUsage(creds.accessToken, creds.accountId, controller.signal);

    // A refused token is either expired, which the Codex CLI clears on its own next run, or revoked.
    // Nothing readable here separates them, so this renders nothing and asks again on the fail TTL
    // rather than telling someone whose login works that it does not.
    if (result?.unauthorized) {
      writeCacheSlot(CODEX_CACHE_SLOT, null, true, 0, NO_CREDENTIALS_KIND);
      return { kind: 'none' };
    }
    if (result?.rateLimited) return codexCacheError('rateLimit', readBackoffState(CODEX_CACHE_SLOT) + 1);

    if (result) {
      writeCacheSlot(CODEX_CACHE_SLOT, result);
      return { kind: 'data', ...result };
    }

    return codexCacheError('generic');
  } catch {
    return codexCacheError('generic');
  } finally {
    clearTimeout(timer);
    releaseHudLock(lock);
  }
}

// --- coral backend ---

function hasValidBackendPid(info) {
  return Number.isInteger(info?.pid) && info.pid >= 1 && info.pid <= 2_147_483_647;
}

// Coral daemon state is account-neutral; Claude credentials only select the
// provider context for an individual request.
function resolveBackendInfoPath() {
  const infoPath = coralBackendInfoPath(homedir());
  try {
    const info = JSON.parse(readFileSync(infoPath, 'utf-8'));
    if (!hasValidBackendPid(info)) return null;
    return infoPath;
  } catch {
    return null;
  }
}

const REEF_INFO_PATH = join(CLAUDE_DIR, 'coral', 'reef.json');

function readReefInfo() {
  try {
    const info = JSON.parse(readFileSync(REEF_INFO_PATH, 'utf-8'));
    if (!isSafeReefUrl(info?.url)) return null;
    return info;
  } catch {
    return null;
  }
}

function isSafeReefUrl(value) {
  if (typeof value !== 'string' || value !== stripControlSequences(value) || /\s/u.test(value)) return false;
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname !== '' && !url.username && !url.password;
  } catch {
    return false;
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
  const cached = readBackendSlot();
  if (cached) return cached;

  const backendInfoPath = resolveBackendInfoPath();
  if (!backendInfoPath) return null;

  let info;
  try {
    info = JSON.parse(readFileSync(backendInfoPath, 'utf-8'));
    if (!hasValidBackendPid(info)) return null;
  } catch {
    return null;
  }

  let processDead = false;
  try {
    process.kill(info.pid, 0);
  } catch (error) {
    processDead = error?.code === 'ESRCH';
  }
  if (!processDead && (!info.port || !info.bootToken)) return null;

  const lock = acquireFetchLock('backend');
  if (!lock) {
    return readStaleBackendSlot();
  }

  try {
    if (processDead) {
      const slot = { line: `${RED}coral${RESET}`, indicator: null };
      writeBackendSlot(slot);
      return slot;
    }
    // Job counts live behind `?detailed=1` and the boot token; the bare `/health` ping carries none.
    const resp = await fetch(`http://${info.host ?? '127.0.0.1'}:${info.port}/health?detailed=1`, {
      headers: { 'X-Coral-Boot-Token': info.bootToken },
      signal: AbortSignal.timeout(CORAL_HEALTH_TIMEOUT_MS),
    });
    if (!resp.ok) {
      const slot = { line: `${DIM}coral${RESET}`, indicator: null };
      writeBackendSlot(slot);
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
    writeBackendSlot(slot);
    return slot;
  } catch {
    const slot = { line: `${DIM}coral${RESET}`, indicator: null };
    writeBackendSlot(slot);
    return slot;
  } finally {
    releaseHudLock(lock);
  }
}

// --- main ---

// An OSC hyperlink wrapper occupies no columns and is as long as the URL inside it, so a width taken
// without stripping it pushes every right-aligned slot left by that much.
const ANSI_SGR_RE = /\x1b\[[0-9;]*m/g;
const ANSI_OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

function visualLen(str) {
  return str.replace(ANSI_SGR_RE, '').replace(ANSI_OSC_RE, '').length;
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

const CODEX_MODEL_DEFAULT = 'gpt-6-sol';

// A project-local settings file is repository content, so this value arrives from whoever wrote the
// repo rather than from the user reading it: it is printed every render and must carry no control
// sequence and no width a clone gets to choose.
export function readSettingsEnvValue(path, key) {
  try {
    const value = JSON.parse(readFileSync(path, 'utf-8'))?.env?.[key];
    if (typeof value !== 'string' || value.length === 0) return undefined;
    const safe = stripControlSequences(value).trim().slice(0, 32);
    return safe.length > 0 ? safe : undefined;
  } catch {
    return undefined;
  }
}

// This slot exists so the user can see which default they configured, so it is the settings value
// itself and must not be resolved into the model a call will run. A request names its own model and
// concurrent jobs in one project can each name a different one, so there is no single effective model
// for a statusline to show, and nothing to ask the backend for.
//
// This statusLine subprocess inherits the parent session's env, frozen at session start, so
// `process.env` cannot answer what CORAL_CODEX_MODEL is now and a shell-exported one may not be
// consulted either — honoring that frozen snapshot would make unsetting the value impossible.
function resolveCodexModelDisplay(input) {
  const projectDir = input.cwd || input.workspace?.current_dir || input.workspace?.project_dir;
  const paths = [];
  if (projectDir) {
    paths.push(join(projectDir, '.claude', 'settings.local.json'));
    paths.push(join(projectDir, '.claude', 'settings.json'));
  }
  paths.push(join(CLAUDE_DIR, 'settings.json'));
  for (const path of paths) {
    const value = readSettingsEnvValue(path, 'CORAL_CODEX_MODEL');
    if (value) return value;
  }
  return CODEX_MODEL_DEFAULT;
}

async function main() {
  const input = await readStdin();
  if (!input) {
    process.stdout.write('');
    return;
  }

  sweepOrphanedTemps();

  const safe = (p) => p.catch(() => null);
  // A renderer that throws may cost its own slot and nothing else. Without this the three async
  // renderers are contained and the synchronous ones are not, so one bad field blanks the statusline
  // including everything already computed.
  const slot = (render) => {
    try {
      return render();
    } catch {
      return null;
    }
  };
  const [limits, rawCodexData, coralSlot] = await Promise.all([
    safe(renderLimits()),
    safe(renderCodexData()),
    safe(renderCoralLine()),
  ]);
  const codexData = rawCodexData ?? { kind: 'none' };

  const claudeModel = slot(() => renderModel(input));
  let col1Claude, col1Codex, col2Claude, col2Codex;
  let codexCreditStr = null;

  if (codexData.kind === 'data') {
    [col1Claude, col1Codex] = alignColumns(claudeModel, slot(() => resolveCodexModelDisplay(input)));
    const codexLimits = formatLimits(codexData.codex);
    codexCreditStr = formatCodexCreditState(codexData.codex?.credits, codexData.codex?.spendControl, !codexLimits);
    [col2Claude, col2Codex] = alignColumns(limits, codexLimits);
  } else {
    col1Claude = claudeModel;
    col2Claude = limits;
    col1Codex = null;
    col2Codex = null;
  }

  const transcript = slot(() => parseTranscript(input)) ?? { activity: null, lastUserMessage: null };

  const line1 = [
    col1Claude,
    col2Claude,
    slot(() => renderContext(input)),
    slot(() => renderSession(input)),
    slot(() => renderGitBranch(input)),
    transcript.activity,
  ].filter(Boolean);

  let output = line1.join(SEP);

  if (codexData.kind === 'data') {
    if (col1Codex) col1Codex = `${GREEN}${col1Codex}${RESET}`;
    const line2 = [col1Codex, col2Codex, codexCreditStr].filter(Boolean);
    if (line2.length > 0) {
      output += '\n' + line2.join(SEP);
    }
  } else if (codexData.kind === 'error') {
    output += '\n' + codexData.message;
  }

  if (coralSlot) {
    const coralLine = typeof coralSlot === 'string' ? coralSlot : coralSlot.line;
    const rightIndicator = typeof coralSlot === 'string' ? null : coralSlot.indicator;
    const targetWidth = visualLen(line1.join(SEP));
    const coralFinal = composeCoralThirdLine(coralLine, rightIndicator, transcript.lastUserMessage, targetWidth);
    output += '\n' + coralFinal;
  }

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
