import { readFileSync, writeFileSync, mkdirSync, readdirSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import type { SessionState } from '../types.js';
import { isNoEntryError, providerIdentPattern } from '../shared/mcp-utils.js';

export interface SessionEntry {
  sessionId: string;
  provider: string;
  name: string;
  state: SessionState;
  activeJobId?: string;
  lastJobId?: string;
  conversationRef?: string;
  model: string;
  cwd: string;
  createdAt: string;
  lastUsedAt: string;
}

function projectHash(dir: string): string {
  return createHash('sha256').update(resolve(dir)).digest('hex').slice(0, 12);
}

function isValidEntry(value: unknown): value is SessionEntry {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.sessionId === 'string'
    && typeof v.provider === 'string'
    && typeof v.name === 'string'
    && typeof v.state === 'string'
    && (v.state === 'pending' || v.state === 'ready' || v.state === 'non_resumable')
    && typeof v.model === 'string'
    && typeof v.cwd === 'string'
    && providerIdentPattern.test(v.provider);
}

/** Migrate old runner session format to new format if possible. Returns null if migration fails. */
function migrateOldEntry(value: Record<string, unknown>): SessionEntry | null {
  if (typeof value.id !== 'string' || typeof value.provider !== 'string') return null;
  if (!providerIdentPattern.test(value.provider)) return null;
  return {
    sessionId: value.id,
    provider: value.provider as string,
    name: typeof value.name === 'string' ? value.name : value.id,
    state: 'ready',
    conversationRef: typeof value.threadId === 'string' ? value.threadId : undefined,
    model: typeof value.model === 'string' ? value.model : 'unknown',
    cwd: typeof value.workingDirectory === 'string' ? value.workingDirectory : '',
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : new Date().toISOString(),
    lastUsedAt: typeof value.lastUsedAt === 'string' ? value.lastUsedAt : new Date().toISOString(),
  };
}

export class SessionManager {
  private readonly sessionDir: string;

  constructor(workingDirectory: string) {
    this.sessionDir = join(homedir(), '.claude', 'coral', 'execution', 'sessions', projectHash(workingDirectory));
    mkdirSync(this.sessionDir, { recursive: true });
  }

  private sessionPath(sessionId: string): string {
    return join(this.sessionDir, `${sessionId}.json`);
  }

  private readEntry(sessionId: string): SessionEntry | null {
    try {
      const data = readFileSync(this.sessionPath(sessionId), 'utf-8');
      const parsed: unknown = JSON.parse(data);
      if (isValidEntry(parsed)) return parsed;
      if (parsed && typeof parsed === 'object') {
        const migrated = migrateOldEntry(parsed as Record<string, unknown>);
        if (migrated) {
          this.writeEntry(migrated);
          return migrated;
        }
      }
      process.stderr.write(`Warning: Session file ${sessionId}.json has unexpected shape, skipping\n`);
      return null;
    } catch (error: unknown) {
      if (isNoEntryError(error)) return null;
      if (error instanceof SyntaxError) {
        process.stderr.write(`Warning: Corrupt session file ${sessionId}.json, skipping\n`);
        return null;
      }
      throw error;
    }
  }

  private writeEntry(entry: SessionEntry): void {
    const filePath = this.sessionPath(entry.sessionId);
    const tmpPath = filePath + '.tmp';
    writeFileSync(tmpPath, JSON.stringify(entry, null, 2), 'utf-8');
    renameSync(tmpPath, filePath);
  }

  /** Allocate a new sessionId and persist as 'pending'. Returns the new entry. */
  allocate(provider: string, name: string, model: string, cwd: string): SessionEntry {
    const now = new Date().toISOString();
    const entry: SessionEntry = {
      sessionId: randomUUID(),
      provider,
      name,
      state: 'pending',
      model,
      cwd,
      createdAt: now,
      lastUsedAt: now,
    };
    this.writeEntry(entry);
    return entry;
  }

  /** Set conversationRef and transition state from pending -> ready. */
  setConversationRef(sessionId: string, conversationRef: string): void {
    const entry = this.readEntry(sessionId);
    if (!entry) return;
    entry.conversationRef = conversationRef;
    entry.state = 'ready';
    entry.lastUsedAt = new Date().toISOString();
    this.writeEntry(entry);
  }

  /** Transition session to non_resumable (provider completed without yielding a conversationRef). */
  setNonResumable(sessionId: string): void {
    const entry = this.readEntry(sessionId);
    if (!entry) return;
    entry.state = 'non_resumable';
    entry.lastUsedAt = new Date().toISOString();
    this.writeEntry(entry);
  }

  /**
   * Claim the session for a new job. Enforces single-active-job invariant.
   * Returns false if session is already running (activeJobId is set).
   */
  claimForJob(sessionId: string, jobId: string): boolean {
    const entry = this.readEntry(sessionId);
    if (!entry || entry.activeJobId) return false;
    entry.activeJobId = jobId;
    entry.lastUsedAt = new Date().toISOString();
    this.writeEntry(entry);
    return true;
  }

  /** Release job claim: clear activeJobId, set lastJobId to completed job. */
  releaseJob(sessionId: string, jobId: string): void {
    const entry = this.readEntry(sessionId);
    if (!entry || entry.activeJobId !== jobId) return;
    entry.activeJobId = undefined;
    entry.lastJobId = jobId;
    entry.lastUsedAt = new Date().toISOString();
    this.writeEntry(entry);
  }

  /** Provider-scoped lookup. Returns null if sessionId not found or provider mismatch. */
  get(provider: string, sessionId: string): SessionEntry | null {
    const entry = this.readEntry(sessionId);
    if (!entry || entry.provider !== provider) return null;
    return entry;
  }

  /** List all sessions for a provider. */
  list(provider: string): SessionEntry[] {
    try {
      const files = readdirSync(this.sessionDir).filter((file) => file.endsWith('.json'));
      return files
        .map((file) => this.readEntry(file.slice(0, -5)))
        .filter((entry): entry is SessionEntry => entry !== null && entry.provider === provider);
    } catch {
      return [];
    }
  }
}
