import { describe, expect, it } from 'vitest';

import { makeEvent, type DiscussDomainEvent, type PersistedDiscussSnapshot } from '#src/discuss/events.js';
import { reduceDiscussEvent, replayDiscussEvents } from '#src/discuss/reducer.js';
import { TEST_PROVIDER_SCOPE } from '../../helpers/provider-credentials.js';
import { decideBid, decideBidRoundClose, decideSessionCreate, decideSpeech } from '#src/discuss/state-machine.js';
import type { DiscussCreateInput, Result } from '#src/discuss/session-types.js';

const NOW = '2026-03-11T00:00:00.000Z';
const PROJECT_ROOT = '/tmp/project';
const SESSION_ID = 'session-1';

function unwrap<T>(result: Result<T>): T {
  if (result.ok) {
    return result.value;
  }
  throw new Error(result.error);
}

function applyEvents(snapshot: PersistedDiscussSnapshot, events: DiscussDomainEvent[]): PersistedDiscussSnapshot {
  return events.reduce((current, event) => reduceDiscussEvent(current, event), snapshot);
}

function replay(
  snapshot: PersistedDiscussSnapshot | undefined,
  events: DiscussDomainEvent[],
): PersistedDiscussSnapshot {
  return replayDiscussEvents(events, snapshot);
}

function nextSeq(snapshot: PersistedDiscussSnapshot): number {
  return snapshot.lastAppliedSeq + 1;
}

function makeInput(agents: DiscussCreateInput['agents'], minBidDelayMs = 0): DiscussCreateInput {
  return {
    topic: 'Should the city pedestrianize the downtown core?',
    agents,
    min_bid_delay_ms: minBidDelayMs,
  };
}

describe('discuss reducer', () => {
  it('matches incremental reduce and tail replay for a creation -> bid -> speech cycle', () => {
    const input = makeInput([
      { name: 'alpha', persona: 'Alpha', participation: 'required' },
      { name: 'beta', persona: 'Beta', participation: 'observer' },
    ]);

    const history: DiscussDomainEvent[] = [];
    const created = unwrap(
      decideSessionCreate(input, { sessionId: SESSION_ID, projectRoot: PROJECT_ROOT, topic: input.topic }, 1, NOW, {
        providerScope: TEST_PROVIDER_SCOPE,
      }),
    );
    history.push(...created);
    let snapshot = replay(undefined, created);

    const alphaBid = unwrap(
      decideBid(
        snapshot.state,
        'alpha',
        10,
        'I can go later.',
        { sessionId: SESSION_ID, projectRoot: PROJECT_ROOT, topic: input.topic },
        nextSeq(snapshot),
        NOW,
      ),
    );
    history.push(...alphaBid);
    snapshot = replay(snapshot, alphaBid);

    const betaBid = unwrap(
      decideBid(
        snapshot.state,
        'beta',
        20,
        'I should break the tie now.',
        { sessionId: SESSION_ID, projectRoot: PROJECT_ROOT, topic: input.topic },
        nextSeq(snapshot),
        NOW,
      ),
    );
    history.push(...betaBid);
    snapshot = replay(snapshot, betaBid);

    const closed = unwrap(
      decideBidRoundClose(
        snapshot.state,
        { sessionId: SESSION_ID, projectRoot: PROJECT_ROOT, topic: input.topic },
        nextSeq(snapshot),
        NOW,
      ),
    );
    history.push(...closed);
    snapshot = replay(snapshot, closed);

    const speech = unwrap(
      decideSpeech(
        snapshot.state,
        'beta',
        'I will open the discussion.',
        { sessionId: SESSION_ID, projectRoot: PROJECT_ROOT, topic: input.topic },
        nextSeq(snapshot),
        NOW,
      ),
    );
    history.push(...speech);

    const fullReplay = replay(undefined, history);
    const incremental = applyEvents(replay(undefined, history.slice(0, 1)), history.slice(1));
    const tailReplay = replay(replay(undefined, history.slice(0, 4)), history.slice(4));

    expect(incremental).toEqual(fullReplay);
    expect(tailReplay).toEqual(fullReplay);
    expect(fullReplay.state.status).toBe('bidding');
    expect(fullReplay.state.step).toBe(2);
    expect(fullReplay.state.last_speech_step).toBe(1);
    expect(fullReplay.state.current_speaker).toBeNull();
    expect(fullReplay.state.agents.beta.total_speaks).toBe(1);
    expect(fullReplay.runtime.controlPhase).toBe('idle');
  });

  it('skips unknown-agent speech events without stopping replay', () => {
    const input = makeInput([
      { name: 'alpha', persona: 'Alpha', participation: 'required' },
      { name: 'beta', persona: 'Beta', participation: 'required' },
    ]);
    const created = unwrap(
      decideSessionCreate(input, { sessionId: SESSION_ID, projectRoot: PROJECT_ROOT, topic: input.topic }, 1, NOW, {
        providerScope: TEST_PROVIDER_SCOPE,
      }),
    );
    const history: DiscussDomainEvent[] = [
      ...created,
      makeEvent(SESSION_ID, PROJECT_ROOT, input.topic, 3, 'speech.recorded', NOW, {
        agent: 'ghost',
        content: 'This event references no configured agent.',
        decrementQuota: true,
        recordLastSpeechStep: 1,
      }),
      makeEvent(SESSION_ID, PROJECT_ROOT, input.topic, 4, 'speech.timed_out', NOW, {
        agent: 'ghost',
        content: 'Ghost timed out.',
        decrementQuota: false,
      }),
      makeEvent(SESSION_ID, PROJECT_ROOT, input.topic, 5, 'bid.submitted', NOW, {
        agent: 'alpha',
        score: 55,
        thought: 'Replay should continue.',
      }),
    ];
    let snapshot: PersistedDiscussSnapshot | undefined;

    expect(() => {
      snapshot = replayDiscussEvents(history);
    }).not.toThrow();

    expect(snapshot?.lastAppliedSeq).toBe(5);
    expect(snapshot?.state.step).toBe(1);
    expect(snapshot?.state.transcript).toEqual([]);
    expect(snapshot?.state.current_bids.alpha).toBe(55);
    expect(snapshot?.state.current_thoughts.alpha).toBe('Replay should continue.');
  });
});
