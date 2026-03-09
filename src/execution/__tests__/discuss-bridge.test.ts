import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discussBaseDir, discussEventLogPath } from '../../client/paths.js';
import { DiscussBridge, type DiscussMachineEvent } from '../discuss-bridge.js';

let projectRoot: string;
let bridge: DiscussBridge;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'coral-discuss-bridge-'));
  bridge = new DiscussBridge(projectRoot);
});

afterEach(() => {
  bridge.close();
  rmSync(projectRoot, { recursive: true, force: true });
});

function createSessionDir(dirName: string): string {
  const sessionDir = join(discussBaseDir(projectRoot), dirName);
  mkdirSync(sessionDir, { recursive: true });
  return sessionDir;
}

function createEvent(sessionId: string, seq: number): DiscussMachineEvent {
  return {
    sessionId,
    topic: 'Bridge topic',
    projectRoot,
    seq,
    kind: 'speech_recorded',
    ts: `2026-03-10T02:24:0${seq}.000Z`,
    payload: { seq },
  };
}

describe('DiscussBridge', () => {
  it('discovers legacy and current-format session directories and returns sorted events', () => {
    const legacySessionId = '260310-0224-abcd';
    const currentSessionId = '20260310-022405-ef12';
    const legacyDir = createSessionDir(`${legacySessionId}-legacy-topic`);
    const currentDir = createSessionDir(`${currentSessionId}-current-topic`);
    createSessionDir('not-a-session');
    writeFileSync(join(discussBaseDir(projectRoot), 'discovery.json'), '{}', 'utf8');

    writeFileSync(
      discussEventLogPath(legacyDir),
      `${JSON.stringify(createEvent(legacySessionId, 2))}\n${JSON.stringify(createEvent(legacySessionId, 1))}\n`,
      'utf8',
    );
    writeFileSync(discussEventLogPath(currentDir), `${JSON.stringify(createEvent(currentSessionId, 1))}\n`, 'utf8');

    bridge.rescan();

    expect(bridge.poll().map((event) => `${event.sessionId}:${event.seq}`)).toEqual([
      `${currentSessionId}:1`,
      `${legacySessionId}:1`,
      `${legacySessionId}:2`,
    ]);
    expect(bridge.getHighWaterMark(currentSessionId)).toBe(1);
    expect(bridge.getHighWaterMark(legacySessionId)).toBe(2);
  });

  it('tolerates missing event logs until they appear', () => {
    const sessionId = '260310-0224-abcd';
    const sessionDir = createSessionDir(`${sessionId}-missing-log`);

    bridge.rescan();

    expect(bridge.poll()).toEqual([]);
    expect(bridge.getHighWaterMark(sessionId)).toBe(0);

    writeFileSync(discussEventLogPath(sessionDir), `${JSON.stringify(createEvent(sessionId, 1))}\n`, 'utf8');

    expect(bridge.poll().map((event) => event.seq)).toEqual([1]);
    expect(bridge.getHighWaterMark(sessionId)).toBe(1);
  });

  it('buffers partial lines across polls and skips malformed entries', () => {
    const sessionId = '260310-0224-abcd';
    const sessionDir = createSessionDir(`${sessionId}-partial-lines`);
    const logPath = discussEventLogPath(sessionDir);
    const first = JSON.stringify(createEvent(sessionId, 1));
    const second = JSON.stringify(createEvent(sessionId, 2));
    const third = JSON.stringify(createEvent(sessionId, 3));
    const splitAt = Math.floor(second.length / 2);

    writeFileSync(logPath, `${first}\n${second.slice(0, splitAt)}`, 'utf8');

    bridge.rescan();

    expect(bridge.poll().map((event) => event.seq)).toEqual([1]);

    appendFileSync(logPath, `${second.slice(splitAt)}\nnot-json\n${third}\n`, 'utf8');

    expect(bridge.poll().map((event) => event.seq)).toEqual([2, 3]);
    expect(bridge.getHighWaterMark(sessionId)).toBe(3);
  });

  it('only returns newly appended events for an existing cursor', () => {
    const sessionId = '260310-0224-abcd';
    const sessionDir = createSessionDir(`${sessionId}-incremental`);
    const logPath = discussEventLogPath(sessionDir);

    writeFileSync(logPath, `${JSON.stringify(createEvent(sessionId, 1))}\n`, 'utf8');
    bridge.rescan();

    expect(bridge.poll().map((event) => event.seq)).toEqual([1]);
    expect(bridge.poll()).toEqual([]);

    appendFileSync(logPath, `${JSON.stringify(createEvent(sessionId, 2))}\n`, 'utf8');

    expect(bridge.poll().map((event) => event.seq)).toEqual([2]);
  });
});
