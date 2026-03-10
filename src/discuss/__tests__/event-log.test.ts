import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { prepareMutation, appendEvents, type DiscussMachineEvent } from '../event-log.js';

describe('prepareMutation', () => {
  let tmpDir: string;
  let logPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'coral-event-log-'));
    logPath = join(tmpDir, 'events.jsonl');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns nextSeq=1 and null pending bounds for empty log with eventCount=0', () => {
    const { nextSeq, watermark } = prepareMutation(logPath, 0);
    expect(nextSeq).toBe(1);
    expect(watermark.lastDurableSeq).toBe(0);
    expect(watermark.pendingSeqStart).toBeNull();
    expect(watermark.pendingSeqEnd).toBeNull();
  });

  it('returns correct seq range for non-empty batch on empty log', () => {
    const { nextSeq, watermark } = prepareMutation(logPath, 3);
    expect(nextSeq).toBe(1);
    expect(watermark.lastDurableSeq).toBe(0);
    expect(watermark.pendingSeqStart).toBe(1);
    expect(watermark.pendingSeqEnd).toBe(3);
  });

  it('reads existing log and continues seq numbering', () => {
    const existing: DiscussMachineEvent = {
      sessionId: 's1',
      topic: 'T',
      projectRoot: '/r',
      seq: 5,
      kind: 'created',
      ts: new Date().toISOString(),
      payload: {},
    };
    appendEvents(logPath, [existing]);

    const { nextSeq, watermark } = prepareMutation(logPath, 2);
    expect(nextSeq).toBe(6);
    expect(watermark.lastDurableSeq).toBe(5);
    expect(watermark.pendingSeqStart).toBe(6);
    expect(watermark.pendingSeqEnd).toBe(7);
  });
});
