import { readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import type { SessionEntry } from '../types.js';

function projectHash(dir: string): string {
  return createHash('sha256').update(resolve(dir)).digest('hex').slice(0, 12);
}

function isNoEntryError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

// Fixed namespace for deterministic legacy migration.
const LEGACY_SESSION_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

function uuidV5(namespace: string, name: string): string {
  const nsBytes = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  const nameBytes = Buffer.from(name, 'utf-8');
  const hash = createHash('sha1').update(nsBytes).update(nameBytes).digest();

  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;

  const h = hash.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

function isSessionEntryV2(value: unknown): value is SessionEntry {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === 'string'
    && typeof v.name === 'string'
    && typeof v.threadId === 'string'
    && typeof v.model === 'string';
}

type LegacySessionEntryV1 = {
  name: string;
  sessionId: string;
  model: string;
  createdAt: string;
  lastUsedAt: string;
  workingDirectory: string;
};

function isLegacySessionEntryV1(value: unknown): value is LegacySessionEntryV1 {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.name === 'string'
    && typeof v.sessionId === 'string'
    && typeof v.model === 'string'
    && !('id' in v)
    && !('threadId' in v);
}

export class SessionManager {
  private readonly sessionDir: string;

  constructor(workingDirectory: string) {
    this.sessionDir = join(homedir(), '.claude', 'coral', 'sessions', projectHash(workingDirectory));
    mkdirSync(this.sessionDir, { recursive: true });
    this.migrateV1Sessions();
  }

  private sessionPath(id: string): string {
    return join(this.sessionDir, `${id}.json`);
  }

  private readSession(id: string): SessionEntry | null {
    try {
      const data = readFileSync(this.sessionPath(id), 'utf-8');
      const parsed: unknown = JSON.parse(data);
      if (isSessionEntryV2(parsed)) return parsed;
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

  private migrateV1Sessions(): void {
    let files: string[];
    try {
      files = readdirSync(this.sessionDir).filter((f) => f.endsWith('.json'));
    } catch {
      return;
    }

    for (const file of files) {
      try {
        const data = readFileSync(join(this.sessionDir, file), 'utf-8');
        const parsed: unknown = JSON.parse(data);
        if (!isLegacySessionEntryV1(parsed)) continue;

        const legacyName = parsed.name;
        const newId = uuidV5(LEGACY_SESSION_NAMESPACE, legacyName);
        const newPath = this.sessionPath(newId);

        try {
          readFileSync(newPath, 'utf-8');
          continue;
        } catch (err) {
          if (!isNoEntryError(err)) continue;
        }

        const newEntry: SessionEntry = {
          id: newId,
          name: legacyName,
          threadId: parsed.sessionId,
          model: parsed.model,
          createdAt: parsed.createdAt,
          lastUsedAt: parsed.lastUsedAt,
          workingDirectory: parsed.workingDirectory,
        };
        this.writeSession(newId, newEntry);
        try {
          unlinkSync(join(this.sessionDir, file));
        } catch {
          /* ignore cleanup errors */
        }
      } catch {
        // Per-file failure must not block migration for other files.
      }
    }
  }

  register(id: string, name: string, threadId: string, model: string, workingDirectory: string): SessionEntry {
    const now = new Date().toISOString();
    const entry: SessionEntry = { id, name, threadId, model, createdAt: now, lastUsedAt: now, workingDirectory };
    this.writeSession(id, entry);
    return entry;
  }

  get(id: string): SessionEntry | null {
    return this.readSession(id);
  }

  list(): SessionEntry[] {
    try {
      const files = readdirSync(this.sessionDir).filter((f) => f.endsWith('.json'));
      return files
        .map((f) => this.readSession(f.slice(0, -5)))
        .filter((entry): entry is SessionEntry => entry !== null);
    } catch {
      return [];
    }
  }

  updateSession(id: string, fields?: { model?: string }): void {
    const entry = this.readSession(id);
    if (!entry) return;

    entry.lastUsedAt = new Date().toISOString();
    if (fields?.model) entry.model = fields.model;
    this.writeSession(id, entry);
  }

  remove(id: string): boolean {
    try {
      unlinkSync(this.sessionPath(id));
      return true;
    } catch {
      return false;
    }
  }
}
