import { readFileSync } from 'node:fs';
import { isNoEntryError, isRecord } from './mcp-utils.js';
import type { SessionEntry } from './types.js';

export type ProvenanceState = 'authoritative' | 'legacy_unresolved';

export interface LenientSessionEntry {
  sessionId: string;
  provider?: string;
  name?: string;
  state?: string;
  activeJobId?: string;
  lastJobId?: string;
  conversationRef?: string;
  providerContinuity?: Record<string, unknown>;
  model?: string;
  cwd?: string;
  projectRoot?: string;
  createdAt?: string;
  lastUsedAt?: string;
  version?: number;
  provenanceState: ProvenanceState;
}

function readSessionJson(sessionPath: string): unknown | null {
  try {
    return JSON.parse(readFileSync(sessionPath, 'utf-8')) as unknown;
  } catch (error: unknown) {
    if (isNoEntryError(error) || error instanceof SyntaxError) return null;
    throw error;
  }
}

export function isValidSessionEntry(value: unknown): value is SessionEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.sessionId === 'string' &&
    typeof entry.provider === 'string' &&
    typeof entry.name === 'string' &&
    typeof entry.state === 'string' &&
    (entry.state === 'pending' || entry.state === 'ready' || entry.state === 'non_resumable') &&
    typeof entry.model === 'string' &&
    typeof entry.cwd === 'string' &&
    (entry.providerContinuity === undefined || isRecord(entry.providerContinuity)) &&
    typeof entry.version === 'number'
  );
}

export function readSessionEntry(sessionPath: string): SessionEntry | null {
  const entry = readSessionJson(sessionPath);
  if (entry === null) return null;
  return isValidSessionEntry(entry) ? entry : null;
}

export function readSessionEntryLenient(sessionPath: string): LenientSessionEntry | null {
  const entry = readSessionJson(sessionPath);
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
  if (isRecord(entry.providerContinuity)) lenientEntry.providerContinuity = entry.providerContinuity;
  if (typeof entry.model === 'string') lenientEntry.model = entry.model;
  if (typeof entry.cwd === 'string') lenientEntry.cwd = entry.cwd;
  if (projectRoot !== undefined) lenientEntry.projectRoot = projectRoot;
  if (typeof entry.createdAt === 'string') lenientEntry.createdAt = entry.createdAt;
  if (typeof entry.lastUsedAt === 'string') lenientEntry.lastUsedAt = entry.lastUsedAt;
  if (typeof entry.version === 'number') lenientEntry.version = entry.version;

  return lenientEntry;
}
