/**
 * Session registry manager.
 *
 * Persists named sessions to .claude/coral/sessions.json so they survive restarts.
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionEntry, SessionRegistry } from '../types.js';

const REGISTRY_DIR = join('.claude', 'coral');
const REGISTRY_FILE = 'sessions.json';

export class SessionManager {
  private registryPath: string;
  private registry: SessionRegistry;

  constructor(workingDirectory?: string) {
    const baseDir = workingDirectory ?? process.cwd();
    const dir = join(baseDir, REGISTRY_DIR);
    mkdirSync(dir, { recursive: true });
    this.registryPath = join(dir, REGISTRY_FILE);
    this.registry = this.load();
  }

  private load(): SessionRegistry {
    try {
      const data = readFileSync(this.registryPath, 'utf-8');
      return JSON.parse(data) as SessionRegistry;
    } catch (err: unknown) {
      if (err instanceof SyntaxError) {
        process.stderr.write(`Warning: Corrupt session registry at ${this.registryPath}, starting fresh\n`);
      } else if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err;
      }
      return { version: 1, sessions: {} };
    }
  }

  private save(): void {
    const tmpPath = this.registryPath + '.tmp';
    writeFileSync(tmpPath, JSON.stringify(this.registry, null, 2), 'utf-8');
    renameSync(tmpPath, this.registryPath);
  }

  /** Register a new named session */
  register(
    name: string,
    codexThreadId: string,
    model: string,
    workingDirectory: string,
  ): SessionEntry {
    const now = new Date().toISOString();
    const entry: SessionEntry = {
      name,
      codexThreadId,
      model,
      createdAt: now,
      lastUsedAt: now,
      workingDirectory,
    };
    this.registry.sessions[name] = entry;
    this.save();
    return entry;
  }

  /** Look up by name or thread ID (name takes priority) */
  get(nameOrId: string): SessionEntry | null {
    if (this.registry.sessions[nameOrId]) {
      return this.registry.sessions[nameOrId];
    }
    for (const entry of Object.values(this.registry.sessions)) {
      if (entry.codexThreadId === nameOrId) {
        return entry;
      }
    }
    return null;
  }

  /** List all registered sessions */
  list(): SessionEntry[] {
    return Object.values(this.registry.sessions);
  }

  /** Update session fields (lastUsedAt is always updated) */
  updateSession(name: string, fields?: { model?: string }): void {
    const entry = this.registry.sessions[name];
    if (entry) {
      entry.lastUsedAt = new Date().toISOString();
      if (fields?.model) {
        entry.model = fields.model;
      }
      this.save();
    }
  }

  /** Remove a session by name */
  remove(name: string): boolean {
    if (this.registry.sessions[name]) {
      delete this.registry.sessions[name];
      this.save();
      return true;
    }
    return false;
  }
}
