import { readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import type { SessionEntry, SessionProvider } from './types.js';
import { isNoEntryError, providerIdentPattern } from '../shared/mcp-utils.js';

function projectHash(dir: string): string {
  return createHash('sha256').update(resolve(dir)).digest('hex').slice(0, 12);
}

function isSessionProvider(value: unknown): value is SessionProvider {
  return typeof value === 'string' && providerIdentPattern.test(value);
}

function isSessionEntry(value: unknown): value is SessionEntry {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === 'string'
    && typeof v.name === 'string'
    && typeof v.threadId === 'string'
    && typeof v.model === 'string'
    && isSessionProvider(v.provider);
}

export class SessionManager {
  private readonly sessionDir: string;

  constructor(workingDirectory: string) {
    this.sessionDir = join(homedir(), '.claude', 'coral', 'sessions', projectHash(workingDirectory));
    mkdirSync(this.sessionDir, { recursive: true });
  }

  private sessionPath(id: string): string {
    return join(this.sessionDir, `${id}.json`);
  }

  private readSession(id: string): SessionEntry | null {
    try {
      const data = readFileSync(this.sessionPath(id), 'utf-8');
      const parsed: unknown = JSON.parse(data);
      if (isSessionEntry(parsed)) return parsed;
      process.stderr.write(`Warning: Session file ${id}.json has unexpected shape, skipping\n`);
      return null;
    } catch (error: unknown) {
      if (isNoEntryError(error)) return null;
      if (error instanceof SyntaxError) {
        process.stderr.write(`Warning: Corrupt session file ${id}.json, skipping\n`);
        return null;
      }
      throw error;
    }
  }

  private writeSession(id: string, entry: SessionEntry): void {
    const filePath = this.sessionPath(id);
    const tmpPath = filePath + '.tmp';
    writeFileSync(tmpPath, JSON.stringify(entry, null, 2), 'utf-8');
    renameSync(tmpPath, filePath);
  }

  register(
    provider: SessionProvider,
    id: string,
    name: string,
    threadId: string,
    model: string,
    workingDirectory: string,
  ): SessionEntry {
    const now = new Date().toISOString();
    const entry: SessionEntry = {
      id,
      provider,
      name,
      threadId,
      model,
      createdAt: now,
      lastUsedAt: now,
      workingDirectory,
    };
    this.writeSession(id, entry);
    return entry;
  }

  get(provider: SessionProvider, id: string): SessionEntry | null {
    const entry = this.readSession(id);
    if (!entry || entry.provider !== provider) return null;
    return entry;
  }

  list(provider: SessionProvider): SessionEntry[] {
    try {
      const files = readdirSync(this.sessionDir).filter((f) => f.endsWith('.json'));
      return files
        .map((f) => this.readSession(f.slice(0, -5)))
        .filter((entry): entry is SessionEntry => entry !== null && entry.provider === provider);
    } catch {
      return [];
    }
  }

  updateSession(provider: SessionProvider, id: string, fields?: { model?: string; threadId?: string }): void {
    const entry = this.readSession(id);
    if (!entry || entry.provider !== provider) return;

    entry.lastUsedAt = new Date().toISOString();
    if (fields?.model) entry.model = fields.model;
    if (fields?.threadId) entry.threadId = fields.threadId;
    this.writeSession(id, entry);
  }

  remove(provider: SessionProvider, id: string): boolean {
    const entry = this.readSession(id);
    if (!entry || entry.provider !== provider) return false;

    try {
      unlinkSync(this.sessionPath(id));
      return true;
    } catch {
      return false;
    }
  }
}
