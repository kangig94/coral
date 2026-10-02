import { describe, expect, it } from 'vitest';

import { decideBid, decideSessionCreate } from '#src/discuss/state-machine.js';
import type { DiscussCreateInput, Result } from '#src/discuss/session-types.js';
import { DiscussSessionStore, DiscussStaleWriteError } from '#src/discuss/shell/session-store.js';
import { createInMemoryDiscussJournal } from '#tests/helpers/discuss-journal.js';
import { TEST_PROVIDER_SCOPE } from '../../../helpers/provider-credentials.js';

const SESSION_ID = 'session-1';
const PROJECT_ROOT = '/tmp/coral-discuss/project';
const SOURCE = 'local/project-source';
const TOPIC = 'Should the city pedestrianize the downtown core?';

function unwrap<T>(result: Result<T>): T {
  if (result.ok) return result.value;
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

function createStore(source = SOURCE): DiscussSessionStore {
  return new DiscussSessionStore(source, {
    journal: createInMemoryDiscussJournal(),
  });
}

async function appendRoundTripHistory(store: DiscussSessionStore, sessionId = SESSION_ID) {
  const created = await store.append(
    sessionId,
    null,
    unwrap(
      decideSessionCreate(
        makeInput(),
        { sessionId, projectRoot: PROJECT_ROOT, topic: TOPIC },
        1,
        '2026-03-11T00:00:00.000Z',
        { providerScope: TEST_PROVIDER_SCOPE },
      ),
    ),
  );
  return store.append(
    sessionId,
    created.lastAppliedSeq,
    unwrap(
      decideBid(
        created.state,
        'alpha',
        72,
        'Open the core first.',
        { sessionId, projectRoot: PROJECT_ROOT, topic: TOPIC },
        created.lastAppliedSeq + 1,
        '2026-03-11T00:00:01.000Z',
      ),
    ),
  );
}

describe('DiscussSessionStore', () => {
  it('rejects stale compare-and-append attempts', async () => {
    const store = createStore();
    const created = await store.append(
      SESSION_ID,
      null,
      unwrap(
        decideSessionCreate(
          makeInput(),
          { sessionId: SESSION_ID, projectRoot: PROJECT_ROOT, topic: TOPIC },
          1,
          '2026-03-11T00:00:00.000Z',
          { providerScope: TEST_PROVIDER_SCOPE },
        ),
      ),
    );
    const bidEvents = unwrap(
      decideBid(
        created.state,
        'alpha',
        60,
        'Still fresh.',
        { sessionId: SESSION_ID, projectRoot: PROJECT_ROOT, topic: TOPIC },
        created.lastAppliedSeq + 1,
        '2026-03-11T00:00:01.000Z',
      ),
    );

    await expect(store.append(SESSION_ID, 1, bidEvents)).rejects.toMatchObject({
      expectedSeq: 1,
      actualSeq: created.lastAppliedSeq,
    });
    await expect(store.append(SESSION_ID, 1, bidEvents)).rejects.toBeInstanceOf(DiscussStaleWriteError);
  });

  it('shares durable Journal state across store instances when they use the same Journal port', async () => {
    const journal = createInMemoryDiscussJournal();
    const firstStore = new DiscussSessionStore(SOURCE, { journal });
    const secondStore = new DiscussSessionStore(SOURCE, { journal });

    const finalSnapshot = await appendRoundTripHistory(firstStore);

    expect(secondStore.load(SESSION_ID)).toEqual(finalSnapshot);
    expect(secondStore.listSummaries()).toEqual(firstStore.listSummaries());
  });
});
