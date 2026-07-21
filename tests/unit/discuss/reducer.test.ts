import { describe, expect, it } from 'vitest';

import { makeEvent, type DiscussDomainEvent, type PersistedDiscussSnapshot } from '#src/discuss/events.js';
import { reduceDiscussEvent, replayDiscussEvents } from '#src/discuss/reducer.js';
import { TEST_PROVIDER_SCOPE } from '../../helpers/provider-credentials.js';
import {
  decideBid,
  decideBidRoundClose,
  decideSessionCreate,
  decideSpeech,
  type SessionCreateOptions,
} from '#src/discuss/state-machine.js';
import type { DiscussCreateInput, DiscussState, Result } from '#src/discuss/session-types.js';

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

function createSnapshot(
  input: DiscussCreateInput,
  agentExecution?: SessionCreateOptions['agentExecution'],
): PersistedDiscussSnapshot {
  return replayDiscussEvents(
    unwrap(
      decideSessionCreate(input, { sessionId: SESSION_ID, projectRoot: PROJECT_ROOT, topic: input.topic }, 1, NOW, {
        providerScope: TEST_PROVIDER_SCOPE,
        ...(agentExecution ? { agentExecution } : {}),
      }),
    ),
  );
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

  it('ends the session and enters synthesize control for a terminal no-winner batch', () => {
    const input = makeInput([
      { name: 'alpha', persona: 'Alpha', participation: 'required' },
      { name: 'beta', persona: 'Beta', participation: 'required' },
    ]);
    let snapshot = createSnapshot(input);
    snapshot = {
      ...snapshot,
      state: {
        ...snapshot.state,
        cold_start: false,
        agents: {
          alpha: { ...snapshot.state.agents.alpha, quota_remaining: 1 },
          beta: { ...snapshot.state.agents.beta, quota_remaining: 1 },
        },
      },
    };

    snapshot = replay(
      snapshot,
      unwrap(
        decideBid(
          snapshot.state,
          'alpha',
          10,
          'Not enough urgency.',
          { sessionId: SESSION_ID, projectRoot: PROJECT_ROOT, topic: input.topic },
          nextSeq(snapshot),
          NOW,
        ),
      ),
    );
    snapshot = replay(
      snapshot,
      unwrap(
        decideBid(
          snapshot.state,
          'beta',
          20,
          'Still below threshold.',
          { sessionId: SESSION_ID, projectRoot: PROJECT_ROOT, topic: input.topic },
          nextSeq(snapshot),
          NOW,
        ),
      ),
    );

    const terminalBatch = unwrap(
      decideBidRoundClose(
        snapshot.state,
        { sessionId: SESSION_ID, projectRoot: PROJECT_ROOT, topic: input.topic },
        nextSeq(snapshot),
        NOW,
      ),
    );
    const ended = replay(snapshot, terminalBatch);

    expect(terminalBatch.map((event) => event.kind)).toEqual(['bid.round.closed', 'session.ended']);
    expect(ended.state.status).toBe('ended');
    expect(ended.state.end_reason_content).toBe('All participants bid below the threshold. Ending discussion.');
    expect(ended.runtime.controlPhase).toBe('synthesize');
    expect(ended.lastAppliedSeq).toBe(snapshot.lastAppliedSeq + 2);
  });

  it('replays a forced low-bid winner as a speaking turn and decrements quota after speech', () => {
    const input = makeInput([
      { name: 'alpha', persona: 'Alpha', participation: 'required' },
      { name: 'beta', persona: 'Beta', participation: 'required' },
    ]);
    let snapshot = createSnapshot(input);
    snapshot = {
      ...snapshot,
      state: {
        ...snapshot.state,
        cold_start: false,
      },
    };

    snapshot = replay(
      snapshot,
      unwrap(
        decideBid(
          snapshot.state,
          'alpha',
          10,
          'Low urgency.',
          { sessionId: SESSION_ID, projectRoot: PROJECT_ROOT, topic: input.topic },
          nextSeq(snapshot),
          NOW,
        ),
      ),
    );
    snapshot = replay(
      snapshot,
      unwrap(
        decideBid(
          snapshot.state,
          'beta',
          20,
          'Below threshold, but I can keep the discussion moving.',
          { sessionId: SESSION_ID, projectRoot: PROJECT_ROOT, topic: input.topic },
          nextSeq(snapshot),
          NOW,
        ),
      ),
    );

    const closed = replay(
      snapshot,
      unwrap(
        decideBidRoundClose(
          snapshot.state,
          { sessionId: SESSION_ID, projectRoot: PROJECT_ROOT, topic: input.topic },
          nextSeq(snapshot),
          NOW,
        ),
      ),
    );

    expect(closed.state.status).toBe('speaking');
    expect(closed.state.current_speaker).toBe('beta');
    expect(closed.state.speaker_type).toBe('forced');
    expect(closed.state.transcript.at(-1)).toMatchObject({
      type: 'bids',
      winner: 'beta',
      resolve_type: 'forced',
    });

    const afterSpeech = replay(
      closed,
      unwrap(
        decideSpeech(
          closed.state,
          'beta',
          'I will keep the discussion moving despite low urgency.',
          { sessionId: SESSION_ID, projectRoot: PROJECT_ROOT, topic: input.topic },
          nextSeq(closed),
          NOW,
        ),
      ),
    );

    expect(afterSpeech.state.status).toBe('bidding');
    expect(afterSpeech.state.agents.beta.quota_remaining).toBe(2);
  });

  it('replays a forced end reason as end content when explicit content is omitted', () => {
    const input = makeInput([{ name: 'alpha', persona: 'Alpha', participation: 'required' }]);
    const snapshot = createSnapshot(input);

    const ended = replay(snapshot, [
      makeEvent(SESSION_ID, PROJECT_ROOT, input.topic, nextSeq(snapshot), 'session.ended', NOW, {
        force: true,
        reason: 'manual stop',
      }),
    ]);

    expect(ended.state.status).toBe('ended');
    expect(ended.state.end_reason_content).toBe('manual stop');
  });

  it('projects epoch_transition into evaluate_epoch runtime control', () => {
    const input = makeInput([
      { name: 'alpha', persona: 'Alpha', participation: 'required' },
      { name: 'beta', persona: 'Beta', participation: 'required' },
    ]);
    const baseSnapshot = createSnapshot(input);
    const biddingState: DiscussState = {
      ...baseSnapshot.state,
      cold_start: false,
      current_bids: { alpha: 90, beta: 85 },
      current_thoughts: { alpha: 'I am blocked by quota.', beta: 'Same here.' },
      pending_bidders: [],
      agents: {
        alpha: {
          ...baseSnapshot.state.agents.alpha,
          quota_remaining: 0,
          fallback_used: true,
        },
        beta: {
          ...baseSnapshot.state.agents.beta,
          quota_remaining: 0,
          fallback_used: true,
        },
      },
    };

    const snapshot = replay(
      {
        ...baseSnapshot,
        state: biddingState,
      },
      unwrap(
        decideBidRoundClose(
          biddingState,
          { sessionId: SESSION_ID, projectRoot: PROJECT_ROOT, topic: input.topic },
          3,
          NOW,
        ),
      ),
    );

    expect(snapshot.state.status).toBe('bidding');
    expect(snapshot.state.epoch).toBe(2);
    expect(snapshot.state.step).toBe(2);
    expect(snapshot.state.epoch_summary_written).toBeNull();
    expect(snapshot.runtime.controlPhase).toBe('evaluate_epoch');
  });

  it('seeds and updates persisted agent run retry fields from runtime events', () => {
    const input = makeInput([
      { name: 'alpha', persona: 'Alpha', participation: 'required' },
      { name: 'user', persona: 'User', participation: 'observer' },
    ]);
    const created = createSnapshot(input, {
      alpha: { manual: false, provider: 'codex', model: 'gpt-5' },
      user: { manual: true },
    });

    const afterBound = replayDiscussEvents(
      [
        makeEvent(SESSION_ID, PROJECT_ROOT, input.topic, 3, 'agent.run.bound', NOW, {
          agent: 'alpha',
          executionSessionId: 'exec-1',
        }),
        makeEvent(SESSION_ID, PROJECT_ROOT, input.topic, 4, 'agent.job.started', NOW, {
          agent: 'alpha',
          jobId: 'job-1',
          purpose: 'bid',
          attempt: 2,
        }),
        makeEvent(SESSION_ID, PROJECT_ROOT, input.topic, 5, 'agent.job.finished', NOW, {
          agent: 'alpha',
          jobId: 'job-1',
          outcome: 'retryable_parse_error',
          attempt: 2,
        }),
      ],
      created,
    );

    expect(created.runtime.agentRuns).toEqual({
      alpha: {
        provider: 'codex',
        model: 'gpt-5',
      },
    });
    expect(afterBound.runtime.agentRuns.alpha).toEqual({
      provider: 'codex',
      model: 'gpt-5',
      executionSessionId: 'exec-1',
      currentJobId: undefined,
      currentJobPurpose: undefined,
      currentAttempt: 2,
      lastAttemptOutcome: 'retryable_parse_error',
    });
  });
});
