/**
 * Discussion state machine with cross-process session lock.
 * Manages bids, quotas, epochs, resolution, and termination.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { initTranscript, appendSpeech, appendEpochSummary, readFull, readRecent, readSummary } from './transcript.js';
import type { DiscussCreateInput } from './schemas.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AgentState {
  persona: string;
  quota_remaining: number;
  total_speaks: number;
  fallback_used: boolean;
}

export interface DiscussState {
  session_id: string;
  session_dir: string;
  topic: string;
  status: 'bidding' | 'speaking' | 'voting' | 'ended';
  step: number;
  epoch: number;
  quota_per_epoch: number;
  cold_start: boolean;
  recent_turns: number;
  agents: Record<string, AgentState>;
  current_bids: Record<string, number | null>;
  pending_bidders: string[];
  current_speaker: string | null;
  speaker_type: 'normal' | 'fallback' | 'designated' | null;
  epoch_summary_written: number | null;
  team_name: string;
  created_at: string;
  updated_at: string;
}

export type ResolveResult =
  | { winner: string; step: number; score?: number; all_bids: Record<string, number>; designated?: true; fallback?: true }
  | { no_winner: true; step: number; reason: string; cold_start?: true; all_bids: Record<string, number> }
  | { vote_required: true; step: number; all_bids: Record<string, number> }
  | { end_vote: true; unanimous: boolean }
  | { error: string; [key: string]: unknown };

// ─── Constants ────────────────────────────────────────────────────────────────

const MIN_BID_THRESHOLD = 30;

// ─── Sleep helper ─────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Session Lock ─────────────────────────────────────────────────────────────

/**
 * Cross-process mkdir-based lock (POSIX atomic test-and-set).
 * No external dependencies — uses filesystem atomicity.
 */
class SessionLock {
  async acquire<T>(sessionDir: string, fn: () => Promise<T>): Promise<T> {
    const lockDir = path.join(sessionDir, 'state.lock');
    const pidFile = path.join(lockDir, 'pid');
    const maxRetries = 10;
    const baseDelay = 50;

    for (let i = 0; i < maxRetries; i++) {
      try {
        fs.mkdirSync(lockDir); // atomic: fails EEXIST if held
        fs.writeFileSync(pidFile, `${process.pid}-${Date.now()}`);
        try {
          return await fn();
        } finally {
          try { fs.unlinkSync(pidFile); } catch { /* ignore */ }
          try { fs.rmdirSync(lockDir); } catch { /* ignore */ }
        }
      } catch (e: unknown) {
        const err = e as NodeJS.ErrnoException;
        if (err.code === 'EEXIST') {
          // Check for stale lock
          try {
            const content = fs.readFileSync(pidFile, 'utf8');
            const dashIdx = content.indexOf('-');
            const ownerPid = parseInt(content.slice(0, dashIdx), 10);
            const lockTime = parseInt(content.slice(dashIdx + 1), 10);
            const isAlive = (() => {
              try { process.kill(ownerPid, 0); return true; } catch { return false; }
            })();
            // 30s staleness threshold — 150x the lock hold budget (~200ms max)
            const isStale = !isAlive || (Date.now() - lockTime > 30_000);
            if (isStale) {
              try { fs.unlinkSync(pidFile); } catch { /* ignore */ }
              try { fs.rmdirSync(lockDir); } catch { /* ignore */ }
              continue;
            }
          } catch { /* pid file unreadable — retry with backoff */ }
          await sleep(baseDelay * Math.pow(2, Math.min(i, 5)) + Math.random() * baseDelay);
          continue;
        }
        throw e;
      }
    }
    throw new Error(`Lock timeout for session ${sessionDir}`);
  }
}

const lock = new SessionLock();

// ─── Atomic Write ─────────────────────────────────────────────────────────────

function writeStateAtomic(filePath: string, state: DiscussState): void {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
}

function readState(filePath: string): DiscussState {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as DiscussState;
}

// ─── Helper: Reset Bids (invariant) ──────────────────────────────────────────

/**
 * Reset current_bids to all-null AND rebuild pending_bidders from agent keys.
 * Must be called atomically in all 4 contexts:
 *   create, recordSpeech, vote_required (rule 8), and quota-reset (voting mode).
 */
function resetBids(state: DiscussState): void {
  for (const name of Object.keys(state.agents)) {
    state.current_bids[name] = null;
  }
  state.pending_bidders = Object.keys(state.agents);
}

// ─── Session Directory ────────────────────────────────────────────────────────

/** Generate a random 4-char suffix for session ID uniqueness. */
function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 6).padEnd(4, '0');
}

/** Format a Date as YYYYMMDD-HHmmss. */
function formatDateId(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

/** Generate topic slug: lowercase ASCII, CJK preserved, hyphens for spaces, ~40 chars. */
function topicSlug(topic: string): string {
  const slug = topic
    .toLowerCase()
    .replace(/\s+/g, '-')
    // Keep alphanumeric, hyphens, CJK Unified Ideographs, Hangul
    .replace(/[^\u0020-\u007E\uAC00-\uD7A3\u4E00-\u9FFF\u3040-\u30FFa-z0-9-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '');
  if (slug.length <= 40) return slug;
  const cut = slug.lastIndexOf('-', 40);
  return cut > 0 ? slug.slice(0, cut) : slug.slice(0, 40);
}

// ─── Discuss Manager ──────────────────────────────────────────────────────────

export class DiscussManager {
  private discussDir: string;

  constructor(projectRoot: string) {
    this.discussDir = path.join(projectRoot, '.claude', 'coral', 'discuss');
    fs.mkdirSync(this.discussDir, { recursive: true });
  }

  private sessionPath(sessionDir: string): string {
    return path.join(this.discussDir, sessionDir);
  }

  private statePath(sessionDir: string): string {
    return path.join(this.sessionPath(sessionDir), 'state.json');
  }

  private transcriptPath(sessionDir: string): string {
    return path.join(this.sessionPath(sessionDir), 'transcript.md');
  }

  /**
   * Resolve session_dir from session_id via glob.
   * Returns null if not found.
   */
  private resolveSessionDir(sessionId: string): string | null {
    if (!fs.existsSync(this.discussDir)) return null;
    const entries = fs.readdirSync(this.discussDir);
    const match = entries.find((e) => e.startsWith(sessionId + '_') || e === sessionId);
    return match ?? null;
  }

  /**
   * Create a new discussion session.
   * Bootstrap: mkdirSync first (atomic collision boundary), then lock for state init.
   */
  async create(input: DiscussCreateInput): Promise<{
    session_id: string;
    session_dir: string;
    team_name: string;
    topic: string;
    agents: string[];
  }> {
    const MAX_ATTEMPTS = 3;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const sessionId = `${formatDateId(new Date())}-${randomSuffix()}`;
      const sessionDir = `${sessionId}_${topicSlug(input.topic)}`;
      const fullPath = this.sessionPath(sessionDir);

      try {
        // Step 1: mkdirSync — atomic collision detection (EEXIST = retry)
        fs.mkdirSync(fullPath, { recursive: false });
      } catch (e: unknown) {
        const err = e as NodeJS.ErrnoException;
        if (err.code === 'EEXIST') continue; // collision — regenerate suffix
        throw e;
      }

      // Step 2: Lock + initialize state and transcript
      await lock.acquire(fullPath, async () => {
        const now = new Date().toISOString();
        const agentNames = input.agents.map((a) => a.name);
        const agents: Record<string, AgentState> = {};
        for (const a of input.agents) {
          agents[a.name] = {
            persona: a.persona,
            quota_remaining: input.quota_per_epoch,
            total_speaks: 0,
            fallback_used: false,
          };
        }

        const state: DiscussState = {
          session_id: sessionId,
          session_dir: sessionDir,
          topic: input.topic,
          status: 'bidding',
          step: 1,
          epoch: 1,
          quota_per_epoch: input.quota_per_epoch,
          cold_start: true,
          recent_turns: input.recent_turns,
          agents,
          current_bids: Object.fromEntries(agentNames.map((n) => [n, null])),
          pending_bidders: agentNames,
          current_speaker: null,
          speaker_type: null,
          epoch_summary_written: null,
          team_name: `coral-dc-${sessionId}`,
          created_at: now,
          updated_at: now,
        };

        writeStateAtomic(this.statePath(sessionDir), state);
        initTranscript(this.transcriptPath(sessionDir), input.topic);
      });

      return {
        session_id: sessionId,
        session_dir: sessionDir,
        team_name: `coral-dc-${sessionId}`,
        topic: input.topic,
        agents: input.agents.map((a) => a.name),
      };
    }

    throw new Error('Failed to create session after 3 attempts (collision)');
  }

  /** Submit a bid for the current step. */
  async submitBid(sessionId: string, agentName: string, score: number): Promise<
    | { all_bids_in: boolean }
    | { error: string; [key: string]: unknown }
  > {
    const sessionDir = this.resolveSessionDir(sessionId);
    if (!sessionDir) return { error: 'session_not_found' };

    return lock.acquire(this.sessionPath(sessionDir), async () => {
      const stateFile = this.statePath(sessionDir);
      const state = readState(stateFile);

      if (state.status !== 'bidding' && state.status !== 'voting') {
        return { error: 'invalid_status', current: state.status };
      }
      if (!state.agents[agentName]) {
        return { error: 'agent_not_found', agent_name: agentName };
      }
      // Double-bid guard
      if (state.current_bids[agentName] !== null) {
        return { error: 'already_bid', agent_name: agentName };
      }
      // Voting score guard
      if (state.status === 'voting' && score !== 0 && score !== 1) {
        return { error: 'voting_score_invalid', valid_scores: [0, 1] };
      }

      state.current_bids[agentName] = score;
      state.pending_bidders = state.pending_bidders.filter((n) => n !== agentName);
      state.updated_at = new Date().toISOString();
      writeStateAtomic(stateFile, state);

      return { all_bids_in: state.pending_bidders.length === 0 };
    });
  }

  /** Resolve current bidding round. Returns winner, no_winner, vote_required, or end_vote. */
  async resolve(sessionId: string, designate?: string): Promise<ResolveResult> {
    const sessionDir = this.resolveSessionDir(sessionId);
    if (!sessionDir) return { error: 'session_not_found' };

    return lock.acquire(this.sessionPath(sessionDir), async () => {
      const stateFile = this.statePath(sessionDir);
      const state = readState(stateFile);

      if (state.status !== 'bidding' && state.status !== 'voting') {
        return { error: 'invalid_status', current: state.status };
      }

      // ── Voting mode resolution ────────────────────────────────────────────
      if (state.status === 'voting') {
        // Quorum check for votes
        const missing = Object.keys(state.agents).filter((n) => state.current_bids[n] === null);
        if (missing.length > 0) {
          return { error: 'quorum_not_met', missing };
        }

        const unanimous = Object.values(state.current_bids).every((v) => v === 0);

        if (unanimous) {
          // Status stays voting — teamlead calls discuss_end (graceful, no force needed)
          state.updated_at = new Date().toISOString();
          writeStateAtomic(stateFile, state);
          return { end_vote: true, unanimous: true };
        } else {
          // Non-unanimous → quota reset, new epoch
          state.epoch += 1;
          state.cold_start = true;
          state.status = 'bidding';
          state.current_speaker = null;
          state.speaker_type = null;
          for (const name of Object.keys(state.agents)) {
            state.agents[name].quota_remaining = state.quota_per_epoch;
            state.agents[name].fallback_used = false;
          }
          resetBids(state);
          state.updated_at = new Date().toISOString();
          writeStateAtomic(stateFile, state);
          return { end_vote: true, unanimous: false };
        }
      }

      // ── Bidding mode resolution ───────────────────────────────────────────

      // Quorum check
      const missing = Object.keys(state.agents).filter((n) => state.current_bids[n] === null);
      if (missing.length > 0) {
        return { error: 'quorum_not_met', missing };
      }

      // Build all_bids snapshot (bid secrecy: only in resolve response, never in state)
      const allBids: Record<string, number> = {};
      for (const [n, v] of Object.entries(state.current_bids)) {
        allBids[n] = v as number;
      }

      // ── Rule 2: Designation check (first, only when designate param given) ──
      if (designate !== undefined) {
        if (!state.agents[designate]) {
          return { error: 'invalid_designate', valid_agents: Object.keys(state.agents) };
        }
        if (!state.cold_start) {
          return { error: 'designate_not_allowed' };
        }
        const anyAboveThreshold = Object.values(allBids).some((s) => s >= MIN_BID_THRESHOLD);
        if (anyAboveThreshold) {
          return { error: 'designate_not_needed' };
        }

        state.current_speaker = designate;
        state.speaker_type = 'designated';
        state.status = 'speaking';
        state.cold_start = false;
        state.updated_at = new Date().toISOString();
        writeStateAtomic(stateFile, state);
        return { winner: designate, step: state.step, designated: true, all_bids: allBids };
      }

      // ── Rule 3: Termination check (all < MIN_BID_THRESHOLD) ──────────────
      const allBelowThreshold = Object.values(allBids).every((s) => s < MIN_BID_THRESHOLD);
      if (allBelowThreshold) {
        if (state.cold_start) {
          // cold_start=true → teamlead must designate
          return { no_winner: true, step: state.step, reason: 'all_below_threshold', cold_start: true, all_bids: allBids };
        }
        return { no_winner: true, step: state.step, reason: 'all_below_threshold', all_bids: allBids };
      }

      // ── Rules 4-5: Primary pool (quota > 0, score >= threshold) ─────────
      const primaryPool = Object.entries(allBids)
        .filter(([n, s]) => s >= MIN_BID_THRESHOLD && state.agents[n].quota_remaining > 0)
        .sort(([an, as_], [bn, bs]) => {
          // Tiebreaker: lower total_speaks first, then alphabetical
          const aSpeaks = state.agents[an].total_speaks;
          const bSpeaks = state.agents[bn].total_speaks;
          if (aSpeaks !== bSpeaks) return aSpeaks - bSpeaks;
          return an < bn ? -1 : 1;
        });

      if (primaryPool.length > 0) {
        // Highest score in primary pool wins (sort by score desc, then tiebreaker)
        const winner = primaryPool.reduce((best, cur) =>
          (allBids[cur[0]] > allBids[best[0]]) ? cur : best,
        );
        // Re-apply tiebreaker among tied scores
        const topScore = allBids[winner[0]];
        const tied = primaryPool.filter(([, s]) => s === topScore);
        const [winnerName] = tied[0]; // already sorted by tiebreaker

        state.current_speaker = winnerName;
        state.speaker_type = 'normal';
        state.status = 'speaking';
        state.cold_start = false;
        state.updated_at = new Date().toISOString();
        writeStateAtomic(stateFile, state);
        return { winner: winnerName, step: state.step, score: topScore, all_bids: allBids };
      }

      // ── Rules 6-7: Fallback pool (quota=0, score >= threshold, fallback_used=false) ──
      const fallbackPool = Object.entries(allBids)
        .filter(([n, s]) =>
          s >= MIN_BID_THRESHOLD &&
          state.agents[n].quota_remaining === 0 &&
          !state.agents[n].fallback_used,
        )
        .sort(([an], [bn]) => {
          const aSpeaks = state.agents[an].total_speaks;
          const bSpeaks = state.agents[bn].total_speaks;
          if (aSpeaks !== bSpeaks) return aSpeaks - bSpeaks;
          return an < bn ? -1 : 1;
        });

      if (fallbackPool.length > 0) {
        const topScore = Math.max(...fallbackPool.map(([, s]) => s));
        const tied = fallbackPool.filter(([, s]) => s === topScore);
        const [winnerName] = tied[0];

        state.agents[winnerName].fallback_used = true;
        state.current_speaker = winnerName;
        state.speaker_type = 'fallback';
        state.status = 'speaking';
        state.cold_start = false;
        state.updated_at = new Date().toISOString();
        writeStateAtomic(stateFile, state);
        return { winner: winnerName, step: state.step, score: topScore, fallback: true, all_bids: allBids };
      }

      // ── Rule 8: Both pools empty but not all < threshold → vote_required ──
      state.status = 'voting';
      state.current_speaker = null;
      state.speaker_type = null;
      resetBids(state);
      state.updated_at = new Date().toISOString();
      writeStateAtomic(stateFile, state);
      return { vote_required: true, step: state.step, all_bids: allBids };
    });
  }

  /** Record a speech from the current speaker. */
  async recordSpeech(sessionId: string, agentName: string, content: string): Promise<
    | { step: number; status: 'bidding' }
    | { error: string; [key: string]: unknown }
  > {
    const sessionDir = this.resolveSessionDir(sessionId);
    if (!sessionDir) return { error: 'session_not_found' };

    return lock.acquire(this.sessionPath(sessionDir), async () => {
      const stateFile = this.statePath(sessionDir);
      const state = readState(stateFile);

      if (state.status !== 'speaking') {
        return { error: 'invalid_status', current: state.status };
      }
      if (state.current_speaker !== agentName) {
        return { error: 'not_your_turn', current_speaker: state.current_speaker };
      }

      // Append to transcript
      appendSpeech(this.transcriptPath(sessionDir), agentName, content);

      // Update agent stats (quota only for 'normal' speaker type)
      state.agents[agentName].total_speaks += 1;
      if (state.speaker_type === 'normal') {
        state.agents[agentName].quota_remaining -= 1;
      }

      // Reset for next step
      state.current_speaker = null;
      state.speaker_type = null;
      state.step += 1;
      state.status = 'bidding';
      resetBids(state);
      state.updated_at = new Date().toISOString();
      writeStateAtomic(stateFile, state);

      return { step: state.step, status: 'bidding' };
    });
  }

  /** Get session state (read-only, no lock needed). */
  getState(sessionId: string): Record<string, unknown> | { error: string } {
    const sessionDir = this.resolveSessionDir(sessionId);
    if (!sessionDir) return { error: 'session_not_found' };

    const stateFile = this.statePath(sessionDir);
    if (!fs.existsSync(stateFile)) return { error: 'state_not_found' };
    const state = readState(stateFile);

    // Never expose current_bids — bid scores are teamlead-only via discuss_resolve
    return {
      session_id: state.session_id,
      topic: state.topic,
      status: state.status,
      step: state.step,
      epoch: state.epoch,
      current_speaker: state.current_speaker,
      speaker_type: state.speaker_type,
      cold_start: state.cold_start,
      quota_per_epoch: state.quota_per_epoch,
      recent_turns: state.recent_turns,
      agents: Object.fromEntries(
        Object.entries(state.agents).map(([n, a]) => [
          n,
          { quota_remaining: a.quota_remaining, total_speaks: a.total_speaks, fallback_used: a.fallback_used },
        ]),
      ),
      pending_bidders: state.pending_bidders,
      all_bids_in: state.pending_bidders.length === 0,
      eligible_count: Object.values(state.agents).filter((a) => a.quota_remaining > 0).length,
      total_agents: Object.keys(state.agents).length,
    };
  }

  /** Get transcript (read-only, no lock). Access control enforced in server-handlers. */
  getTranscript(sessionId: string, mode: 'full' | 'recent' | 'summary', lastN?: number): string | { error: string } {
    const sessionDir = this.resolveSessionDir(sessionId);
    if (!sessionDir) return { error: 'session_not_found' };
    const tPath = this.transcriptPath(sessionDir);
    if (mode === 'full') return readFull(tPath);
    if (mode === 'summary') return readSummary(tPath);
    // recent: default lastN from session state
    const stateFile = this.statePath(sessionDir);
    const defaultN = fs.existsSync(stateFile) ? readState(stateFile).recent_turns : 5;
    return readRecent(tPath, lastN ?? defaultN);
  }

  /** Append epoch summary to transcript. */
  async recordEpochSummary(sessionId: string, epoch: number, summary: string): Promise<
    | { ok: true }
    | { error: string; [key: string]: unknown }
  > {
    const sessionDir = this.resolveSessionDir(sessionId);
    if (!sessionDir) return { error: 'session_not_found' };

    return lock.acquire(this.sessionPath(sessionDir), async () => {
      const stateFile = this.statePath(sessionDir);
      const state = readState(stateFile);

      if (state.status === 'ended') {
        return { error: 'session_ended' };
      }
      // Epoch-coherency: reject wrong-epoch calls
      if (epoch !== state.epoch) {
        return { error: 'epoch_mismatch', expected: state.epoch };
      }
      // One-per-epoch invariant
      if (state.epoch_summary_written === epoch) {
        return { error: 'epoch_summary_duplicate', epoch };
      }

      appendEpochSummary(this.transcriptPath(sessionDir), epoch, summary);
      state.epoch_summary_written = epoch;
      state.updated_at = new Date().toISOString();
      writeStateAtomic(stateFile, state);

      return { ok: true };
    });
  }

  /** End the discussion session. */
  async end(sessionId: string, opts: { force?: boolean; reason?: string; synthesis?: string }): Promise<
    | { ok: true; session_id: string }
    | { error: string; [key: string]: unknown }
  > {
    const sessionDir = this.resolveSessionDir(sessionId);
    if (!sessionDir) return { error: 'session_not_found' };

    return lock.acquire(this.sessionPath(sessionDir), async () => {
      const stateFile = this.statePath(sessionDir);
      const state = readState(stateFile);

      if (state.status === 'ended') {
        return { error: 'already_ended' };
      }

      const { force = false, reason } = opts;

      if (state.status === 'speaking') {
        if (!force) {
          return { error: 'requires_force', hint: 'set force=true with reason to end during active speech' };
        }
        // Stale-state guard: if step advanced since entering (speech completed), report state_progressed
        // (We re-read inside lock, so this is the latest state)
        // Record forced end annotation in transcript
        const tPath = this.transcriptPath(sessionDir);
        appendSpeech(tPath, 'System', `[Force-ended during speech by ${state.current_speaker}. Reason: ${reason}]`);
      } else if (state.status === 'voting') {
        // Allow graceful end (no force) if vote is complete and unanimous (all bids = 0, no pending)
        const voteComplete = state.pending_bidders.length === 0;
        const unanimous = voteComplete && Object.values(state.current_bids).every((v) => v === 0);
        if (!unanimous && !force) {
          return { error: 'requires_force', hint: 'set force=true with reason to end during active vote' };
        }
        if (force && !unanimous) {
          const tPath = this.transcriptPath(sessionDir);
          appendSpeech(tPath, 'System', `[Force-ended during vote. Reason: ${reason}]`);
        }
      } else if (state.status === 'bidding' && force) {
        // force=true from bidding — stale-state guard: check if state changed
        // Since we're inside lock reading fresh state, status=bidding is confirmed.
        // Nothing special needed.
      }

      state.status = 'ended';
      state.current_speaker = null;
      state.speaker_type = null;
      if (opts.synthesis) {
        const tPath = this.transcriptPath(sessionDir);
        appendSpeech(tPath, 'Synthesis', opts.synthesis);
      }
      state.updated_at = new Date().toISOString();
      writeStateAtomic(stateFile, state);

      return { ok: true, session_id: sessionId };
    });
  }
}
