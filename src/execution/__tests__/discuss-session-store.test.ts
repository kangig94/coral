import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readDiscussDiscovery, readDiscussEventLog } from '../../client/readers.js';
import {
  DISCUSS_PROJECT_ROOTS_PATH,
  discussDiscoveryPath,
  discussEventLogPath,
  discussSessionDir,
  discussStatePath,
  syncHomePaths,
} from '../../client/paths.js';
import { replayDiscussEvents } from '../../discuss/reducer.js';
import {
  decideBid,
  decideBidRoundClose,
  decideSessionCreate,
  decideSpeech,
} from '../../discuss/state-machine.js';
import type { DiscussCreateInput, Result } from '../../discuss/types.js';
import {
  DiscussSessionStore,
  DiscussStaleWriteError,
} from '../discuss-session-store.js';

const SESSION_ID = 'session-1';
const SECOND_SESSION_ID = 'session-2';
const TOPIC = 'Should the city pedestrianize the downtown core?';

let projectRoot = '';
let homeRoot = '';
const originalHome = process.env.HOME;

function unwrap<T>(result: Result<T>): T {
  if (result.ok) {
    return result.value;
  }
  throw new Error(result.error);
}

function makeInput(): DiscussCreateInput {
  return {
    topic: TOPIC,
    min_bid_delay_ms: 0,
    agents: [
      { name: 'alpha', persona: 'Alpha', participation: 'required' },
      { name: 'beta', persona: 'Beta', participation: 'required' },
    ],
  };
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  const tmpPath = `${filePath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(value, null, 2), 'utf8');
  renameSync(tmpPath, filePath);
}

async function appendRoundTripHistory(store: DiscussSessionStore, sessionId = SESSION_ID): Promise<{
  finalSnapshot: Awaited<ReturnType<DiscussSessionStore['append']>>;
}> {
  const input = makeInput();
  const createEvents = unwrap(
    decideSessionCreate(
      input,
      sessionId,
      projectRoot,
      TOPIC,
      1,
      '2026-03-11T00:00:00.000Z',
    ),
  );
  const created = await store.append(sessionId, 0, createEvents);

  const bidAlpha = unwrap(
    decideBid(
      created.state,
      'alpha',
      60,
      'I should open the discussion.',
      sessionId,
      projectRoot,
      TOPIC,
      3,
      '2026-03-11T00:00:01.000Z',
    ),
  );
  const afterAlpha = await store.append(sessionId, created.lastAppliedSeq, bidAlpha);

  const bidBeta = unwrap(
    decideBid(
      afterAlpha.state,
      'beta',
      75,
      'I should take the first turn.',
      sessionId,
      projectRoot,
      TOPIC,
      4,
      '2026-03-11T00:00:02.000Z',
    ),
  );
  const afterBeta = await store.append(sessionId, afterAlpha.lastAppliedSeq, bidBeta);

  const closeRound = unwrap(
    decideBidRoundClose(
      afterBeta.state,
      sessionId,
      projectRoot,
      TOPIC,
      5,
      '2026-03-11T00:00:03.000Z',
    ),
  );
  const afterClose = await store.append(sessionId, afterBeta.lastAppliedSeq, closeRound);

  const speech = unwrap(
    decideSpeech(
      afterClose.state,
      'beta',
      'I will open with the transportation impact.',
      sessionId,
      projectRoot,
      TOPIC,
      6,
      '2026-03-11T00:00:04.000Z',
    ),
  );
  const finalSnapshot = await store.append(sessionId, afterClose.lastAppliedSeq, speech);

  return { finalSnapshot };
}

beforeEach(() => {
  homeRoot = mkdtempSync(join(tmpdir(), 'coral-discuss-home-'));
  process.env.HOME = homeRoot;
  syncHomePaths();
  projectRoot = mkdtempSync(join(tmpdir(), 'coral-discuss-store-'));
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
  rmSync(homeRoot, { recursive: true, force: true });
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  syncHomePaths();
});

describe('DiscussSessionStore', () => {
  it('appends events and loads the same snapshot back', async () => {
    const store = new DiscussSessionStore(projectRoot);
    const { finalSnapshot } = await appendRoundTripHistory(store);

    expect(store.load(SESSION_ID)).toEqual(finalSnapshot);
    expect(store.listSummaries()).toEqual([
      {
        sessionId: SESSION_ID,
        projectRoot,
        topic: TOPIC,
        status: 'bidding',
        createdAt: '2026-03-11T00:00:00.000Z',
        agentCount: 2,
        authority: 'persisted',
      },
    ]);
    expect(JSON.parse(readFileSync(DISCUSS_PROJECT_ROOTS_PATH, 'utf8'))).toEqual({
      updatedAt: finalSnapshot.updatedAt,
      projectRoots: [projectRoot],
    });
  });

  it('recovers the full session state by replaying the event log when state.json is deleted', async () => {
    const store = new DiscussSessionStore(projectRoot);
    const { finalSnapshot } = await appendRoundTripHistory(store);
    const statePath = discussStatePath(store.resolveSessionDir(SESSION_ID));

    unlinkSync(statePath);

    expect(store.load(SESSION_ID)).toEqual(finalSnapshot);
  });

  it('replays only the tail past snapshot.lastAppliedSeq and matches full replay', async () => {
    const store = new DiscussSessionStore(projectRoot);
    const { finalSnapshot } = await appendRoundTripHistory(store);
    const sessionDir = store.resolveSessionDir(SESSION_ID);
    const logEvents = readDiscussEventLog(discussEventLogPath(sessionDir));
    const truncatedSnapshot = replayDiscussEvents(logEvents.slice(0, 4));

    writeJsonAtomic(discussStatePath(sessionDir), truncatedSnapshot);

    expect(store.load(SESSION_ID)).toEqual(finalSnapshot);
  });

  it('rejects compare-and-append when expectedSeq is stale', async () => {
    const store = new DiscussSessionStore(projectRoot);
    const input = makeInput();
    const createEvents = unwrap(
      decideSessionCreate(
        input,
        SESSION_ID,
        projectRoot,
        TOPIC,
        1,
        '2026-03-11T00:00:00.000Z',
      ),
    );
    const created = await store.append(SESSION_ID, 0, createEvents);

    const bidEvents = unwrap(
      decideBid(
        created.state,
        'alpha',
        60,
        'Still fresh.',
        SESSION_ID,
        projectRoot,
        TOPIC,
        3,
        '2026-03-11T00:00:01.000Z',
      ),
    );

    await expect(store.append(SESSION_ID, 1, bidEvents)).rejects.toBeInstanceOf(DiscussStaleWriteError);
    await expect(store.append(SESSION_ID, 1, bidEvents)).rejects.toMatchObject({
      expectedSeq: 1,
      actualSeq: created.lastAppliedSeq,
    });
  });

  it('updates discovery.json after each committed append', async () => {
    const store = new DiscussSessionStore(projectRoot);
    const input = makeInput();
    const createEvents = unwrap(
      decideSessionCreate(
        input,
        SESSION_ID,
        projectRoot,
        TOPIC,
        1,
        '2026-03-11T00:00:00.000Z',
      ),
    );
    const created = await store.append(SESSION_ID, 0, createEvents);
    const firstDiscovery = readDiscussDiscovery(projectRoot);

    expect(firstDiscovery).toEqual({
      projectRoot,
      updatedAt: created.updatedAt,
      sessions: [{
        sessionId: SESSION_ID,
        topic: TOPIC,
        sessionDir: discussSessionDir(projectRoot, SESSION_ID),
        createdAt: created.state.created_at,
      }],
    });

    const bidEvents = unwrap(
      decideBid(
        created.state,
        'alpha',
        60,
        'Discovery should advance on this append.',
        SESSION_ID,
        projectRoot,
        TOPIC,
        3,
        '2026-03-11T00:00:01.000Z',
      ),
    );
    const afterBid = await store.append(SESSION_ID, created.lastAppliedSeq, bidEvents);
    const secondDiscovery = readDiscussDiscovery(projectRoot);

    expect(secondDiscovery?.updatedAt).toBe(afterBid.updatedAt);
    expect(secondDiscovery?.sessions).toHaveLength(1);
    expect(secondDiscovery?.sessions[0]).toMatchObject({
      sessionId: SESSION_ID,
      topic: TOPIC,
      createdAt: created.state.created_at,
    });
  });

  it('preserves both discovery rows when different sessions append concurrently', async () => {
    const firstStore = new DiscussSessionStore(projectRoot);
    const secondStore = new DiscussSessionStore(projectRoot);
    const input = makeInput();

    const firstCreate = unwrap(
      decideSessionCreate(
        input,
        SESSION_ID,
        projectRoot,
        TOPIC,
        1,
        '2026-03-11T00:00:00.000Z',
      ),
    );
    const secondCreate = unwrap(
      decideSessionCreate(
        input,
        SECOND_SESSION_ID,
        projectRoot,
        `${TOPIC} (session 2)`,
        1,
        '2026-03-11T00:00:00.500Z',
      ),
    );

    await Promise.all([
      firstStore.append(SESSION_ID, 0, firstCreate),
      secondStore.append(SECOND_SESSION_ID, 0, secondCreate),
    ]);

    const discovery = readDiscussDiscovery(projectRoot);
    expect(discovery?.sessions.map((session) => session.sessionId).sort()).toEqual([
      SESSION_ID,
      SECOND_SESSION_ID,
    ]);
  });

  it('falls back from missing, stale, or corrupt discovery data when listing and loading committed sessions', async () => {
    const store = new DiscussSessionStore(projectRoot);
    await appendRoundTripHistory(store, SESSION_ID);
    await appendRoundTripHistory(store, SECOND_SESSION_ID);

    const firstSnapshot = store.load(SESSION_ID);
    const secondSnapshot = store.load(SECOND_SESSION_ID);
    expect(firstSnapshot).not.toBeNull();
    expect(secondSnapshot).not.toBeNull();

    writeJsonAtomic(discussDiscoveryPath(projectRoot), {
      projectRoot,
      updatedAt: '2026-03-11T00:00:05.000Z',
      sessions: [{
        sessionId: SESSION_ID,
        topic: TOPIC,
        sessionDir: discussSessionDir(projectRoot, SESSION_ID),
        createdAt: '2026-03-11T00:00:00.000Z',
      }],
    });

    expect(store.listRecoveryCandidates().map((session) => session.sessionId).sort()).toEqual([
      SESSION_ID,
      SECOND_SESSION_ID,
    ]);
    expect(store.load(SECOND_SESSION_ID)).toEqual(secondSnapshot);

    unlinkSync(discussDiscoveryPath(projectRoot));

    expect(store.listRecoveryCandidates().map((session) => session.sessionId).sort()).toEqual([
      SESSION_ID,
      SECOND_SESSION_ID,
    ]);
    expect(store.load(SESSION_ID)).toEqual(firstSnapshot);

    writeFileSync(discussDiscoveryPath(projectRoot), '{ not valid json }', 'utf8');

    expect(store.listRecoveryCandidates().map((session) => session.sessionId).sort()).toEqual([
      SESSION_ID,
      SECOND_SESSION_ID,
    ]);
  });

  it('skips corrupt event-log lines without breaking load', async () => {
    const store = new DiscussSessionStore(projectRoot);
    const { finalSnapshot } = await appendRoundTripHistory(store);
    const logPath = discussEventLogPath(store.resolveSessionDir(SESSION_ID));

    appendFileSync(logPath, '{ not valid json }\n');

    expect(store.load(SESSION_ID)).toEqual(finalSnapshot);
  });

  it('writes the committed event batch to the session log', async () => {
    const store = new DiscussSessionStore(projectRoot);
    await appendRoundTripHistory(store);
    const logPath = discussEventLogPath(store.resolveSessionDir(SESSION_ID));

    const lines = readFileSync(logPath, 'utf8')
      .trim()
      .split('\n');

    expect(lines).toHaveLength(6);
    expect(JSON.parse(lines[0]) as { kind: string; seq: number }).toMatchObject({
      kind: 'session.created',
      seq: 1,
    });
    expect(JSON.parse(lines[5]) as { kind: string; seq: number }).toMatchObject({
      kind: 'speech.recorded',
      seq: 6,
    });
  });
});
