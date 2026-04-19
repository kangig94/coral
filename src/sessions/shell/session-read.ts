import { readFileSync } from 'node:fs';

import type { RuntimeStoragePort } from '../../runtime/ports.js';
import { isNoEntryError, isRecord } from '../../shared/utils.js';
import { sessionEntrySchema, type SessionEntry } from '../entry.js';

export type ProvenanceState = 'authoritative' | 'legacy_unresolved';

export interface LenientSessionEntry {
  sessionId: string;
  provider?: string;
  name?: string;
  agentName?: string;
  state?: string;
  activeJobId?: string;
  lastJobId?: string;
  conversationRef?: string;
  providerContinuity?: Record<string, unknown>;
  model?: string;
  cwd?: string;
  projectRoot?: string;
  backendNamespace?: string;
  createdAt?: string;
  lastUsedAt?: string;
  version?: number;
  provenanceState: ProvenanceState;
}

type SessionEntryStorage = Pick<RuntimeStoragePort, 'readFileSync'>;

function defaultStorage(): SessionEntryStorage {
  return { readFileSync };
}

export function readSessionJson(
  sessionPath: string,
  storage?: SessionEntryStorage,
): unknown | null {
  try {
    const reader = storage ?? defaultStorage();
    return JSON.parse(reader.readFileSync(sessionPath, 'utf-8')) as unknown;
  } catch (error: unknown) {
    if (isNoEntryError(error) || error instanceof SyntaxError) return null;
    throw error;
  }
}

export function isValidSessionEntry(value: unknown): value is SessionEntry {
  return sessionEntrySchema.safeParse(value).success;
}

export function readSessionEntry(
  sessionPath: string,
  storage?: SessionEntryStorage,
): SessionEntry | null {
  const entry = readSessionJson(sessionPath, storage);
  if (entry === null) return null;
  return isValidSessionEntry(entry) ? entry : null;
}

export function readSessionEntryLenient(
  sessionPath: string,
  storage?: SessionEntryStorage,
): LenientSessionEntry | null {
  const entry = readSessionJson(sessionPath, storage);
  if (!isRecord(entry) || typeof entry.sessionId !== 'string') return null;

  const projectRoot =
    typeof entry.projectRoot === 'string' && entry.projectRoot.length > 0 ? entry.projectRoot : undefined;
  const backendNamespace =
    typeof entry.backendNamespace === 'string' && entry.backendNamespace.length > 0
      ? entry.backendNamespace
      : undefined;
  const lenientEntry: LenientSessionEntry = {
    sessionId: entry.sessionId,
    provenanceState:
      projectRoot !== undefined && backendNamespace !== undefined ? 'authoritative' : 'legacy_unresolved',
  };

  if (typeof entry.provider === 'string') lenientEntry.provider = entry.provider;
  if (typeof entry.name === 'string') lenientEntry.name = entry.name;
  if (typeof entry.agentName === 'string') lenientEntry.agentName = entry.agentName;
  if (typeof entry.state === 'string') lenientEntry.state = entry.state;
  if (typeof entry.activeJobId === 'string') lenientEntry.activeJobId = entry.activeJobId;
  if (typeof entry.lastJobId === 'string') lenientEntry.lastJobId = entry.lastJobId;
  if (typeof entry.conversationRef === 'string') lenientEntry.conversationRef = entry.conversationRef;
  if (isRecord(entry.providerContinuity)) lenientEntry.providerContinuity = entry.providerContinuity;
  if (typeof entry.model === 'string') lenientEntry.model = entry.model;
  if (typeof entry.cwd === 'string') lenientEntry.cwd = entry.cwd;
  if (projectRoot !== undefined) lenientEntry.projectRoot = projectRoot;
  if (backendNamespace !== undefined) lenientEntry.backendNamespace = backendNamespace;
  if (typeof entry.createdAt === 'string') lenientEntry.createdAt = entry.createdAt;
  if (typeof entry.lastUsedAt === 'string') lenientEntry.lastUsedAt = entry.lastUsedAt;
  if (typeof entry.version === 'number') lenientEntry.version = entry.version;

  return lenientEntry;
}
