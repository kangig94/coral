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

type SessionEntryV2NoProvider = Omit<SessionEntry, 'provider'>;

function isSessionEntryV2NoProvider(value: unknown): value is SessionEntryV2NoProvider {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === 'string'
    && typeof v.name === 'string'
    && typeof v.threadId === 'string'
    && typeof v.model === 'string'
    && !('provider' in v);
}

function isSessionEntryV2(value: unknown): value is SessionEntry {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === 'string'
    && typeof v.name === 'string'
    && typeof v.threadId === 'string'
    && typeof v.model === 'string'
    && isSessionProvider(v.provider);
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
      if (isSessionEntryV2NoProvider(parsed)) {
        const migrated: SessionEntry = { ...parsed, provider: 'codex' };
        this.writeSession(id, migrated);
        return migrated;
      }
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
          provider: 'codex',
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

  register(
    provider: SessionProvider,
    id: string,
    name: string,
    threadId: string,
    model: string,
    workingDirectory: string,
  ): SessionEntry;
  register(
    id: string,
    name: string,
    threadId: string,
    model: string,
    workingDirectory: string,
  ): SessionEntry;
  register(
    providerOrId: SessionProvider | string,
    idOrName: string,
    nameOrThreadId: string,
    threadIdOrModel: string,
    modelOrWorkingDirectory: string,
    maybeWorkingDirectory?: string,
  ): SessionEntry {
    let provider: SessionProvider;
    let id: string;
    let name: string;
    let threadId: string;
    let model: string;
    let workingDirectory: string;

    if (maybeWorkingDirectory == null) {
      provider = 'codex';
      id = providerOrId;
      name = idOrName;
      threadId = nameOrThreadId;
      model = threadIdOrModel;
      workingDirectory = modelOrWorkingDirectory;
    } else {
      provider = providerOrId;
      id = idOrName;
      name = nameOrThreadId;
      threadId = threadIdOrModel;
      model = modelOrWorkingDirectory;
      workingDirectory = maybeWorkingDirectory;
    }

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

  get(provider: SessionProvider, id: string): SessionEntry | null;
  get(id: string): SessionEntry | null;
  get(providerOrId: SessionProvider | string, maybeId?: string): SessionEntry | null {
    const provider: SessionProvider = maybeId == null ? 'codex' : providerOrId;
    const id = maybeId == null ? providerOrId : maybeId;
    const entry = this.readSession(id);
    if (!entry || entry.provider !== provider) return null;
    return entry;
  }

  list(provider: SessionProvider): SessionEntry[];
  list(): SessionEntry[];
  list(provider: SessionProvider = 'codex'): SessionEntry[] {
    try {
      const files = readdirSync(this.sessionDir).filter((f) => f.endsWith('.json'));
      return files
        .map((f) => this.readSession(f.slice(0, -5)))
        .filter((entry): entry is SessionEntry => entry !== null && entry.provider === provider);
    } catch {
      return [];
    }
  }

  updateSession(provider: SessionProvider, id: string, fields?: { model?: string; threadId?: string }): void;
  updateSession(id: string, fields?: { model?: string; threadId?: string }): void;
  updateSession(
    providerOrId: SessionProvider | string,
    idOrFields?: string | { model?: string; threadId?: string },
    maybeFields?: { model?: string; threadId?: string },
  ): void {
    const hasProvider = typeof idOrFields === 'string';
    const provider: SessionProvider = hasProvider ? providerOrId : 'codex';
    const id = hasProvider ? idOrFields : providerOrId;
    const fields = hasProvider ? maybeFields : idOrFields;

    const entry = this.readSession(id);
    if (!entry || entry.provider !== provider) return;

    entry.lastUsedAt = new Date().toISOString();
    if (fields?.model) entry.model = fields.model;
    if (fields?.threadId) entry.threadId = fields.threadId;
    this.writeSession(id, entry);
  }

  remove(provider: SessionProvider, id: string): boolean;
  remove(id: string): boolean;
  remove(providerOrId: SessionProvider | string, maybeId?: string): boolean {
    const provider: SessionProvider = maybeId == null ? 'codex' : providerOrId;
    const id = maybeId == null ? providerOrId : maybeId;
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
