import * as fs from 'node:fs';
import * as path from 'node:path';
import { discussEventLogPath } from '../client/paths.js';
import { textResult, type McpResult } from '../shared/mcp-utils.js';
import { appendEvents, type DiscussMachineEvent, type WatermarkMeta } from './event-log.js';
import { renderEntries, renderHeader } from './transcript.js';
import { randomSuffix, formatDateId, topicSlug } from './util/string.js';
import type { AgentState, DiscussState } from './types.js';
import { writeStateAtomic, SessionLock } from './lock.js';

export class SessionStore {
  private readonly discussDir: string;
  private lock = new SessionLock();
  private renderCursors = new Map<string, number>();

  constructor(projectRoot: string) {
    this.discussDir = path.join(projectRoot, '.claude', 'coral', 'discuss');
    fs.mkdirSync(this.discussDir, { recursive: true });
  }

  createSessionDir(topic: string): { sessionId: string; sessionDir: string; fullPath: string } {
    for (let attempt = 0; attempt < 3; attempt++) {
      const sessionId = `${formatDateId(new Date())}-${randomSuffix()}`;
      const sessionDir = `${sessionId}-${topicSlug(topic)}`;
      const fullPath = path.join(this.discussDir, sessionDir);
      try {
        fs.mkdirSync(fullPath, { recursive: false });
        return { sessionId, sessionDir, fullPath };
      } catch (e: unknown) {
        const err = e as NodeJS.ErrnoException;
        if (err.code === 'EEXIST') continue;
        throw e;
      }
    }
    throw new Error('Failed to create session after 3 attempts (collision)');
  }

  resolveDir(sessionId: string): string | null {
    const exactPath = path.join(this.discussDir, sessionId);
    try {
      fs.statSync(exactPath);
      return exactPath;
    } catch { /* not an exact match — try prefix */ }

    try {
      const match = fs.readdirSync(this.discussDir).find((e) => e.startsWith(`${sessionId}-`));
      return match ? path.join(this.discussDir, match) : null;
    } catch {
      return null;
    }
  }

  resolveOrError(sessionId: string): string | McpResult {
    return this.resolveDir(sessionId) ?? textResult('session_not_found', true);
  }

  statePath(fullSessionPath: string): string {
    return path.join(fullSessionPath, 'state.json');
  }

  load(fullSessionPath: string): DiscussState {
    const raw = JSON.parse(fs.readFileSync(this.statePath(fullSessionPath), 'utf8')) as Record<string, unknown> | null;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`Invalid discuss state shape in ${fullSessionPath}: expected object`);
    }

    if (typeof raw.session_id !== 'string' || typeof raw.topic !== 'string' || typeof raw.status !== 'string') {
      throw new Error(`Invalid discuss state shape in ${fullSessionPath}: missing required fields`);
    }

    if (raw.agents === null || typeof raw.agents !== 'object' || Array.isArray(raw.agents)) {
      throw new Error(`Invalid discuss state shape in ${fullSessionPath}: missing agents`);
    }

    if (!Array.isArray(raw.transcript)) {
      throw new Error(`Invalid discuss state shape in ${fullSessionPath}: missing transcript`);
    }

    for (const [name, agent] of Object.entries(raw.agents)) {
      if (agent === null || typeof agent !== 'object' || Array.isArray(agent)) {
        throw new Error(`Invalid agent shape for '${name}' in ${fullSessionPath}: expected object`);
      }
      const a = agent as Record<string, unknown>;
      if (typeof a.participation !== 'string') {
        throw new Error(`Invalid agent shape for '${name}' in ${fullSessionPath}: missing participation field`);
      }
    }

    if (typeof raw.min_bid_delay_ms !== 'number') {
      throw new Error(`Invalid discuss state shape in ${fullSessionPath}: missing min_bid_delay_ms`);
    }

    const stateWithCursor = raw as DiscussState & { transcript_rendered?: number; _watermark?: WatermarkMeta };
    this.renderCursors.set(fullSessionPath, stateWithCursor.transcript_rendered ?? stateWithCursor.transcript.length);
    const { transcript_rendered: _transcript_rendered, _watermark: _watermark, ...state } = stateWithCursor;
    return state;
  }

  save(fullSessionPath: string, state: DiscussState): void {
    const cursor = this.renderCursors.get(fullSessionPath) ?? 0;
    const newEntries = state.transcript.slice(cursor);
    const hasNewEntries = newEntries.length > 0;
    if (hasNewEntries) {
      const md = renderEntries(newEntries, state.agents);
      fs.appendFileSync(path.join(fullSessionPath, 'transcript.md'), md, 'utf8');
    }
    const nextCursor = state.transcript.length;
    const toWrite = { ...state, transcript_rendered: nextCursor };
    writeStateAtomic(this.statePath(fullSessionPath), toWrite);
    this.renderCursors.set(fullSessionPath, nextCursor);
  }

  persistMutation(
    fullSessionPath: string,
    state: DiscussState,
    machineEvents: DiscussMachineEvent[],
    watermark: WatermarkMeta,
  ): void {
    const cursor = this.renderCursors.get(fullSessionPath) ?? 0;
    const newEntries = state.transcript.slice(cursor);
    if (newEntries.length > 0) {
      const md = renderEntries(newEntries, state.agents);
      fs.appendFileSync(path.join(fullSessionPath, 'transcript.md'), md, 'utf8');
    }

    const nextCursor = state.transcript.length;
    const toWrite = { ...state, transcript_rendered: nextCursor, _watermark: watermark };
    writeStateAtomic(this.statePath(fullSessionPath), toWrite);
    this.renderCursors.set(fullSessionPath, nextCursor);

    if (machineEvents.length > 0) {
      appendEvents(discussEventLogPath(fullSessionPath), machineEvents);
    }
  }

  initTranscript(fullSessionPath: string, topic: string, agents: Record<string, AgentState>): void {
    fs.writeFileSync(path.join(fullSessionPath, 'transcript.md'), renderHeader(topic, agents), 'utf8');
  }

  async withLock<T>(fullSessionPath: string, fn: () => Promise<T>): Promise<T> {
    return this.lock.acquire(fullSessionPath, fn);
  }

  async loadLocked(fullSessionPath: string): Promise<DiscussState> {
    return this.withLock(fullSessionPath, async () => this.load(fullSessionPath));
  }

  cleanupExpiredSessions(): number {
    const ttlDays = Number.parseInt(process.env.CORAL_DISCUSS_TTL_DAYS ?? '0', 10);
    const ttl = Number.isFinite(ttlDays) && ttlDays > 0 ? ttlDays : 0;
    if (ttl === 0) return 0;
    const cutoff = Date.now() - ttl * 24 * 60 * 60 * 1000;
    let removed = 0;

    let entries: string[];
    try {
      entries = fs.readdirSync(this.discussDir);
    } catch {
      return 0;
    }
    for (const entry of entries) {
      const fullPath = path.join(this.discussDir, entry);
      const statePath = path.join(fullPath, 'state.json');
      try {
        const raw = JSON.parse(fs.readFileSync(statePath, 'utf8')) as Record<string, unknown>;
        if (raw['status'] !== 'ended') continue;
        const ts = String(raw['last_activity_at'] || '');
        if (new Date(ts).getTime() >= cutoff) continue;
        fs.rmSync(fullPath, { recursive: true, force: true });
        this.renderCursors.delete(fullPath);
        removed += 1;
      } catch {
        continue;
      }
    }
    return removed;
  }
}
