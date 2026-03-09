import { closeSync, openSync, readSync, readdirSync, type Dirent } from 'node:fs';
import { join } from 'node:path';
import { discussBaseDir, discussEventLogPath } from '../client/paths.js';
import type { DiscussMachineEvent, DiscussMachineEventKind } from '../discuss/event-log.js';
import { isNoEntryError, isRecord } from '../shared/mcp-utils.js';

export type { DiscussMachineEvent } from '../discuss/event-log.js';

const READ_CHUNK = 8 * 1024;
const SESSION_DIR_PATTERN = /^((?:\d{8}-\d{6}|\d{6}-\d{4})-[a-z0-9]+)-.+$/;
const DISCUSS_EVENT_KINDS = new Set<DiscussMachineEventKind>([
  'created',
  'bidding_started',
  'bid_recorded',
  'round_resolved',
  'speech_recorded',
  'speech_timeout',
  'agents_expelled',
  'epoch_summary_recorded',
  'session_ended',
]);

type SessionCursor = {
  sessionId: string;
  sessionDir: string;
  lastOffset: number;
  remainder: string;
  highWaterSeq: number;
};

/**
 * Tails discuss session event logs from the filesystem for execution-side consumers.
 */
export class DiscussBridge {
  private readonly projectRoot: string;
  private readonly cursors = new Map<string, SessionCursor>();
  private readonly readBuf = Buffer.alloc(READ_CHUNK);
  private closed = false;

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
  }

  /**
   * Poll for newly appended discuss machine events across all tracked sessions.
   */
  poll(): DiscussMachineEvent[] {
    if (this.closed) {
      return [];
    }

    const allEvents: DiscussMachineEvent[] = [];
    for (const cursor of this.cursors.values()) {
      allEvents.push(...this.readNewEvents(cursor));
    }

    allEvents.sort(compareEvents);
    return allEvents;
  }

  /**
   * Scan the discuss directory and begin tracking any newly discovered session logs.
   */
  rescan(): void {
    if (this.closed) {
      return;
    }

    const baseDir = discussBaseDir(this.projectRoot);
    let entries: Dirent[];
    try {
      entries = readdirSync(baseDir, { withFileTypes: true });
    } catch (error: unknown) {
      if (isNoEntryError(error)) {
        return;
      }
      throw error;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const sessionId = extractSessionId(entry.name);
      if (!sessionId || this.cursors.has(sessionId)) {
        continue;
      }

      this.cursors.set(sessionId, {
        sessionId,
        sessionDir: join(baseDir, entry.name),
        lastOffset: 0,
        remainder: '',
        highWaterSeq: 0,
      });
    }
  }

  /**
   * Return the last seen durable sequence number for a tracked session.
   */
  getHighWaterMark(sessionId: string): number {
    return this.cursors.get(sessionId)?.highWaterSeq ?? 0;
  }

  /**
   * Stop tracking discuss logs and clear in-memory cursors.
   */
  close(): void {
    this.closed = true;
    this.cursors.clear();
  }

  private readNewEvents(cursor: SessionCursor): DiscussMachineEvent[] {
    const lines = this.readNewLines(discussEventLogPath(cursor.sessionDir), cursor);
    if (lines.length === 0) {
      return [];
    }

    const eventsBySeq = new Map<number, DiscussMachineEvent>();
    for (const line of lines) {
      const event = parseDiscussMachineEvent(line);
      if (!event || event.sessionId !== cursor.sessionId) {
        continue;
      }
      if (event.seq <= cursor.highWaterSeq || eventsBySeq.has(event.seq)) {
        continue;
      }
      eventsBySeq.set(event.seq, event);
    }

    const events = [...eventsBySeq.values()].sort((a, b) => a.seq - b.seq);
    if (events.length > 0) {
      cursor.highWaterSeq = events[events.length - 1].seq;
    }
    return events;
  }

  private readNewLines(filePath: string, cursor: SessionCursor): string[] {
    let fd: number;
    try {
      fd = openSync(filePath, 'r');
    } catch (error: unknown) {
      if (isNoEntryError(error)) {
        return [];
      }
      throw error;
    }

    try {
      const chunks: string[] = [];
      let nextOffset = cursor.lastOffset;

      while (true) {
        const bytesRead = readSync(fd, this.readBuf, 0, READ_CHUNK, nextOffset);
        if (bytesRead <= 0) {
          break;
        }

        nextOffset += bytesRead;
        chunks.push(this.readBuf.toString('utf-8', 0, bytesRead));
        if (bytesRead < READ_CHUNK) {
          break;
        }
      }

      cursor.lastOffset = nextOffset;
      if (chunks.length === 0) {
        return [];
      }

      const combined = cursor.remainder + chunks.join('');
      const lines = combined.split('\n');
      cursor.remainder = lines.pop() ?? '';
      return lines.filter((line) => line.trim().length > 0);
    } finally {
      closeSync(fd);
    }
  }
}

function extractSessionId(dirName: string): string | null {
  const match = dirName.match(SESSION_DIR_PATTERN);
  return match?.[1] ?? null;
}

function compareEvents(a: DiscussMachineEvent, b: DiscussMachineEvent): number {
  if (a.sessionId < b.sessionId) {
    return -1;
  }
  if (a.sessionId > b.sessionId) {
    return 1;
  }
  return a.seq - b.seq;
}

function parseDiscussMachineEvent(line: string): DiscussMachineEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }

  if (!isRecord(parsed)) {
    return null;
  }

  if (
    typeof parsed.sessionId !== 'string'
    || typeof parsed.topic !== 'string'
    || typeof parsed.projectRoot !== 'string'
    || !Number.isInteger(parsed.seq)
    || typeof parsed.kind !== 'string'
    || !DISCUSS_EVENT_KINDS.has(parsed.kind as DiscussMachineEventKind)
    || typeof parsed.ts !== 'string'
    || !isRecord(parsed.payload)
  ) {
    return null;
  }

  return {
    sessionId: parsed.sessionId as string,
    topic: parsed.topic as string,
    projectRoot: parsed.projectRoot as string,
    seq: parsed.seq as number,
    kind: parsed.kind as DiscussMachineEventKind,
    ts: parsed.ts as string,
    payload: parsed.payload as Record<string, unknown>,
  };
}
