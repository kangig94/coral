import { readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import type { SessionEntry } from '../types.js';

function projectHash(dir: string): string {
  return createHash('sha256').update(resolve(dir)).digest('hex').slice(0, 12);
}

export class SessionManager {
  private sessionDir: string;

  constructor(workingDirectory: string) {
    this.sessionDir = join(homedir(), '.claude', 'coral', 'sessions', projectHash(workingDirectory));
    mkdirSync(this.sessionDir, { recursive: true });
  }

  private sessionPath(name: string): string {
    return join(this.sessionDir, `${name}.json`);
  }

  private readSession(name: string): SessionEntry | null {
    try {
      const data = readFileSync(this.sessionPath(name), 'utf-8');
      return JSON.parse(data) as SessionEntry;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      if (err instanceof SyntaxError) {
        process.stderr.write(`Warning: Corrupt session file ${name}.json, skipping\n`);
        return null;
      }
      throw err;
    }
  }

  private writeSession(name: string, entry: SessionEntry): void {
    const filePath = this.sessionPath(name);
    const tmpPath = filePath + '.tmp';
    writeFileSync(tmpPath, JSON.stringify(entry, null, 2), 'utf-8');
    renameSync(tmpPath, filePath);
  }

  register(name: string, codexThreadId: string, model: string, workingDirectory: string): SessionEntry {
    const now = new Date().toISOString();
    const entry: SessionEntry = { name, codexThreadId, model, createdAt: now, lastUsedAt: now, workingDirectory };
    this.writeSession(name, entry);
    return entry;
  }

  get(nameOrId: string): SessionEntry | null {
    // Try direct name lookup first
    const direct = this.readSession(nameOrId);
    if (direct) return direct;
    // Scan all sessions for threadId match
    for (const entry of this.list()) {
      if (entry.codexThreadId === nameOrId) return entry;
    }
    return null;
  }

  list(): SessionEntry[] {
    try {
      const files = readdirSync(this.sessionDir).filter((f) => f.endsWith('.json') && !f.endsWith('.tmp'));
      const entries: SessionEntry[] = [];
      for (const file of files) {
        const name = file.slice(0, -5); // remove .json
        const entry = this.readSession(name);
        if (entry) entries.push(entry);
      }
      return entries;
    } catch {
      return [];
    }
  }

  updateSession(name: string, fields?: { model?: string }): void {
    const entry = this.readSession(name);
    if (entry) {
      entry.lastUsedAt = new Date().toISOString();
      if (fields?.model) entry.model = fields.model;
      this.writeSession(name, entry);
    }
  }

  remove(name: string): boolean {
    try {
      unlinkSync(this.sessionPath(name));
      return true;
    } catch {
      return false;
    }
  }
}
