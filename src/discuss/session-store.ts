import * as fs from 'node:fs';
import * as path from 'node:path';
import { renderEntries, renderHeader } from './transcript.js';
import { randomSuffix, formatDateId, topicSlug } from './util/string.js';
import type { DiscussState } from './types.js';
import { writeStateAtomic, SessionLock } from './lock.js';

export class SessionStore {
  private readonly discussDir: string;
  private lock = new SessionLock();

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
    if (!fs.existsSync(this.discussDir)) return null;

    const exactPath = path.join(this.discussDir, sessionId);
    if (fs.existsSync(exactPath)) {
      return exactPath;
    }

    const match = fs.readdirSync(this.discussDir).find((entry) => entry.startsWith(`${sessionId}-`));
    return match ? path.join(this.discussDir, match) : null;
  }

  statePath(fullSessionPath: string): string {
    return path.join(fullSessionPath, 'state.json');
  }

  load(fullSessionPath: string): DiscussState {
    const state = JSON.parse(fs.readFileSync(this.statePath(fullSessionPath), 'utf8')) as DiscussState;
    // normalize pre-observer sessions that lack new fields
    for (const agent of Object.values(state.agents)) {
      agent.participation ??= 'required';
    }
    state.min_bid_delay_ms ??= 0;
    return state;
  }

  save(fullSessionPath: string, state: DiscussState): void {
    const newEntries = state.transcript.slice(state.transcript_rendered);
    if (newEntries.length > 0) {
      const md = renderEntries(newEntries, state.agents);
      fs.appendFileSync(path.join(fullSessionPath, 'transcript.md'), md, 'utf8');
    }
    const toWrite = newEntries.length > 0
      ? { ...state, transcript_rendered: state.transcript.length }
      : state;
    writeStateAtomic(this.statePath(fullSessionPath), toWrite);
  }

  initTranscript(fullSessionPath: string, topic: string): void {
    fs.writeFileSync(path.join(fullSessionPath, 'transcript.md'), renderHeader(topic), 'utf8');
  }

  async withLock<T>(fullSessionPath: string, fn: () => Promise<T>): Promise<T> {
    return this.lock.acquire(fullSessionPath, fn);
  }

  cleanupExpiredSessions(): number {
    const ttlDays = Number.parseInt(process.env.CORAL_DISCUSS_TTL_DAYS ?? '', 10);
    const ttl = Number.isFinite(ttlDays) && ttlDays > 0 ? ttlDays : 30;
    const cutoff = Date.now() - ttl * 24 * 60 * 60 * 1000;
    let removed = 0;

    if (!fs.existsSync(this.discussDir)) return 0;
    for (const entry of fs.readdirSync(this.discussDir)) {
      const fullPath = path.join(this.discussDir, entry);
      const statePath = path.join(fullPath, 'state.json');
      try {
        const raw = JSON.parse(fs.readFileSync(statePath, 'utf8')) as Record<string, unknown>;
        if (raw['status'] !== 'ended') continue;
        const ts = String(raw['last_activity_at'] || '');
        if (new Date(ts).getTime() < cutoff) {
          fs.rmSync(fullPath, { recursive: true, force: true });
          removed++;
        }
      } catch {
        continue;
      }
    }
    return removed;
  }
}
