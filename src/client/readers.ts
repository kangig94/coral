import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JOBS_DIR, discussDiscoveryPath } from './paths.js';
import type { PersistedProgressRecord, PersistedStatusRecord } from '../types.js';
import type { SessionEntry } from '../execution/session-manager.js';
import type { DiscussState } from '../discuss/types.js';
import { isNoEntryError } from '../shared/mcp-utils.js';

function readJsonFile(filePath: string): unknown | null {
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as unknown;
  } catch (error: unknown) {
    if (isNoEntryError(error) || error instanceof SyntaxError) return null;
    throw error;
  }
}

function readTextFile(filePath: string): string | null {
  try {
    return readFileSync(filePath, 'utf-8');
  } catch (error: unknown) {
    if (isNoEntryError(error)) return null;
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isValidSessionEntry(value: unknown): value is SessionEntry {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.sessionId === 'string'
    && typeof v.provider === 'string'
    && typeof v.name === 'string'
    && typeof v.state === 'string'
    && (v.state === 'pending' || v.state === 'ready' || v.state === 'non_resumable')
    && typeof v.model === 'string'
    && typeof v.cwd === 'string'
    && typeof v.version === 'number';
}

function isValidDiscussState(value: unknown): value is DiscussState {
  if (!isRecord(value)) return false;
  return typeof value.session_id === 'string'
    && typeof value.topic === 'string'
    && typeof value.status === 'string'
    && isRecord(value.agents);
}

function isValidDiscussEventLogEntry(value: unknown): value is DiscussEventLogEntry {
  if (!isRecord(value)) return false;
  return typeof value.sessionId === 'string'
    && typeof value.topic === 'string'
    && typeof value.projectRoot === 'string'
    && typeof value.seq === 'number'
    && typeof value.kind === 'string'
    && typeof value.ts === 'string'
    && isRecord(value.payload);
}

function isValidDiscussDiscoverySession(value: unknown): value is DiscussDiscoverySession {
  if (!isRecord(value)) return false;
  return typeof value.sessionId === 'string'
    && typeof value.topic === 'string'
    && typeof value.sessionDir === 'string'
    && typeof value.createdAt === 'string';
}

function isValidDiscussDiscoveryData(value: unknown): value is DiscussDiscoveryData {
  if (!isRecord(value) || !Array.isArray(value.sessions)) return false;
  return typeof value.projectRoot === 'string'
    && typeof value.updatedAt === 'string'
    && value.sessions.every(isValidDiscussDiscoverySession);
}

/**
 * Provenance marker for lenient session scans.
 */
export type ProvenanceState = 'authoritative' | 'legacy_unresolved';

/**
 * Backward-compatible session view for indexing and reporting surfaces.
 */
export interface LenientSessionEntry {
  sessionId: string;
  provider?: string;
  name?: string;
  state?: string;
  activeJobId?: string;
  lastJobId?: string;
  conversationRef?: string;
  model?: string;
  cwd?: string;
  projectRoot?: string;
  createdAt?: string;
  lastUsedAt?: string;
  version?: number;
  provenanceState: ProvenanceState;
}

/**
 * Persisted discuss event log entry.
 */
export interface DiscussEventLogEntry {
  sessionId: string;
  topic: string;
  projectRoot: string;
  seq: number;
  kind: string;
  ts: string;
  payload: Record<string, unknown>;
}

/**
 * Session reference stored in discuss discovery metadata.
 */
export interface DiscussDiscoverySession {
  sessionId: string;
  topic: string;
  sessionDir: string;
  createdAt: string;
}

/**
 * Discovery metadata for all discuss sessions under a project root.
 */
export interface DiscussDiscoveryData {
  sessions: DiscussDiscoverySession[];
  projectRoot: string;
  updatedAt: string;
}

/**
 * Reads and parses a persisted job status record.
 */
export function readStatusRecord(jobId: string): PersistedStatusRecord | null {
  const record = readJsonFile(join(JOBS_DIR, jobId, 'status.json'));
  return record === null ? null : record as PersistedStatusRecord;
}

/**
 * Reads and parses all persisted progress records for a job.
 */
export function readProgressLog(jobId: string): PersistedProgressRecord[] {
  const log = readTextFile(join(JOBS_DIR, jobId, 'progress.jsonl'));
  if (log === null) return [];

  const records: PersistedProgressRecord[] = [];
  for (const line of log.split('\n')) {
    if (line.trim().length === 0) continue;
    try {
      records.push(JSON.parse(line) as PersistedProgressRecord);
    } catch (error: unknown) {
      if (error instanceof SyntaxError) continue;
      throw error;
    }
  }
  return records;
}

/**
 * Reads and validates a strict execution session entry JSON file.
 */
export function readSessionEntry(sessionPath: string): SessionEntry | null {
  const entry = readJsonFile(sessionPath);
  if (entry === null) return null;
  return isValidSessionEntry(entry) ? entry : null;
}

/**
 * Reads a session entry for reporting surfaces that must tolerate legacy or partial files.
 */
export function readSessionEntryLenient(sessionPath: string): LenientSessionEntry | null {
  const entry = readJsonFile(sessionPath);
  if (!isRecord(entry) || typeof entry.sessionId !== 'string') return null;

  const projectRoot = typeof entry.projectRoot === 'string' ? entry.projectRoot : undefined;
  const lenientEntry: LenientSessionEntry = {
    sessionId: entry.sessionId,
    provenanceState: projectRoot === undefined ? 'legacy_unresolved' : 'authoritative',
  };

  if (typeof entry.provider === 'string') lenientEntry.provider = entry.provider;
  if (typeof entry.name === 'string') lenientEntry.name = entry.name;
  if (typeof entry.state === 'string') lenientEntry.state = entry.state;
  if (typeof entry.activeJobId === 'string') lenientEntry.activeJobId = entry.activeJobId;
  if (typeof entry.lastJobId === 'string') lenientEntry.lastJobId = entry.lastJobId;
  if (typeof entry.conversationRef === 'string') lenientEntry.conversationRef = entry.conversationRef;
  if (typeof entry.model === 'string') lenientEntry.model = entry.model;
  if (typeof entry.cwd === 'string') lenientEntry.cwd = entry.cwd;
  if (projectRoot !== undefined) lenientEntry.projectRoot = projectRoot;
  if (typeof entry.createdAt === 'string') lenientEntry.createdAt = entry.createdAt;
  if (typeof entry.lastUsedAt === 'string') lenientEntry.lastUsedAt = entry.lastUsedAt;
  if (typeof entry.version === 'number') lenientEntry.version = entry.version;

  return lenientEntry;
}

/**
 * Reads and minimally validates a persisted discuss state file.
 */
export function readDiscussState(statePath: string): DiscussState | null {
  const state = readJsonFile(statePath);
  if (state === null) return null;
  return isValidDiscussState(state) ? state : null;
}

/**
 * Reads and parses a discuss JSONL event log, skipping malformed lines.
 */
export function readDiscussEventLog(logPath: string): DiscussEventLogEntry[] {
  const log = readTextFile(logPath);
  if (log === null) return [];

  const entries: DiscussEventLogEntry[] = [];
  for (const line of log.split('\n')) {
    if (line.trim().length === 0) continue;
    try {
      const entry = JSON.parse(line) as unknown;
      if (isValidDiscussEventLogEntry(entry)) {
        entries.push(entry);
      }
    } catch (error: unknown) {
      if (error instanceof SyntaxError) continue;
      throw error;
    }
  }
  return entries;
}

/**
 * Reads and validates the discuss discovery metadata for a project.
 */
export function readDiscussDiscovery(projectRoot: string): DiscussDiscoveryData | null {
  const discovery = readJsonFile(discussDiscoveryPath(projectRoot));
  if (discovery === null) return null;
  return isValidDiscussDiscoveryData(discovery) ? discovery : null;
}
