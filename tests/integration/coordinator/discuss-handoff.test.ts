// Cross-domain handoff coverage for discuss state across a daemon swap.
// Composes two coordinator cores against a shared journal via the harness,
// seeds a live discuss session on the incumbent, triggers handoff shutdown
// (`reason='replaced'` ⇒ ShutdownMode='handoff'), and asserts:
//
//   1. The incumbent's hooks.onShutdown('handoff') aborts the in-memory
//      session WITHOUT persisting an abort marker to the journal.
//   2. The replacement core's startup recovery (`discussRecovery.runStartup`)
//      reads the same journal, sees the session as live (no abort marker),
//      and re-attaches it in its fresh discussRegistry.
//
// Unit-level coverage already exists for piece (1) in
// `tests/unit/discuss/shell/discuss-manager-lifecycle.test.ts:249`. This file
// adds end-to-end coverage of the lifecycle wiring + recovery composition,
// closing the cross-domain integration gap left open by Phase A2.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { decideSessionCreate } from '#src/discuss/state-machine.js';
import { attachSession, getSession } from '#src/discuss/shell/registry.js';
import type { DiscussCreateInput } from '#src/discuss/session-types.js';
import type { InvocationContext } from '#src/runtime/invocation-context.js';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';
import { testProjectPrincipal } from '#tests/helpers/principal.js';
import { TEST_PROVIDER_SCOPE } from '#tests/helpers/provider-credentials.js';

import { createHandoffCoresHarness, type HandoffCoresHarness } from './handoff-cores-harness.js';

const SEED_TS = '2026-04-27T00:00:00.000Z';
const PROJECT_ROOT = fixtureCanonicalWorkDir(process.cwd());
const SESSION_ID = 'handoff-session';
const TOPIC = 'should the new daemon rehydrate this discuss session?';

function defaultAgents(): Array<DiscussCreateInput['agents'][number]> {
  return [
    { name: 'alpha', persona: '# Alpha', participation: 'required' },
    { name: 'beta', persona: '# Beta', participation: 'required' },
  ];
}

function defaultAgentExecution(agents: ReturnType<typeof defaultAgents>) {
  return Object.fromEntries(
    agents.map((agent) => [agent.name, { manual: false, provider: 'codex' as const, model: 'gpt-5' }] as const),
  );
}

function makeInvocationContext(pluginRoot: string): InvocationContext {
  return { projectRoot: PROJECT_ROOT, pluginRoot, coralEnv: {}, principal: testProjectPrincipal(PROJECT_ROOT) };
}

const harnesses: HandoffCoresHarness[] = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    await harness.cleanup();
  }
});

describe('discuss handoff (cross-domain integration)', () => {
  it('handoff shutdown aborts the session in memory and leaves the journal abort-free', async () => {
    const harness = createHandoffCoresHarness();
    harnesses.push(harness);

    const incumbent = await harness.bootCore({ instanceId: 'incumbent' });
    const ctx = makeInvocationContext(incumbent.core.identity.pluginRoot);
    const source = incumbent.core.resolveProjectSource(PROJECT_ROOT);
    const store = incumbent.core.getDiscussStoreForSource(source);
    const context = incumbent.core.getDiscussContext(ctx);

    const agents = defaultAgents();
    const created = decideSessionCreate(
      { topic: TOPIC, agents, min_bid_delay_ms: 0 },
      { sessionId: SESSION_ID, projectRoot: PROJECT_ROOT, topic: TOPIC },
      1,
      SEED_TS,
      { agentExecution: defaultAgentExecution(agents), providerScope: TEST_PROVIDER_SCOPE },
    );
    if (!created.ok) {
      throw new Error(`seed: decideSessionCreate failed: ${created.error}`);
    }

    const snapshot = await store.append(SESSION_ID, null, created.value);
    const liveSession = attachSession(context, snapshot);
    expect(liveSession.controller.signal.aborted).toBe(false);

    const eventsBefore = store.readSessionEvents(SESSION_ID).map((event) => event.kind);
    expect(eventsBefore).toEqual(['session.created', 'bidding.opened']);

    await incumbent.shutdown('replaced');
    expect(incumbent.core.runtimeState.getLifecycle()).toBe('stopped');

    expect(liveSession.controller.signal.aborted).toBe(true);

    const eventsAfter = store.readSessionEvents(SESSION_ID).map((event) => event.kind);
    expect(eventsAfter).toEqual(['session.created', 'bidding.opened']);
  });

  it('replacement core recovery rehydrates the still-live discuss session from the shared journal', async () => {
    const harness = createHandoffCoresHarness();
    harnesses.push(harness);

    const incumbent = await harness.bootCore({ instanceId: 'incumbent' });
    {
      const ctx = makeInvocationContext(incumbent.core.identity.pluginRoot);
      const source = incumbent.core.resolveProjectSource(PROJECT_ROOT);
      const store = incumbent.core.getDiscussStoreForSource(source);
      const context = incumbent.core.getDiscussContext(ctx);

      const agents = defaultAgents();
      const created = decideSessionCreate(
        { topic: TOPIC, agents, min_bid_delay_ms: 0 },
        { sessionId: SESSION_ID, projectRoot: PROJECT_ROOT, topic: TOPIC },
        1,
        SEED_TS,
        { agentExecution: defaultAgentExecution(agents), providerScope: TEST_PROVIDER_SCOPE },
      );
      if (!created.ok) {
        throw new Error(`seed: decideSessionCreate failed: ${created.error}`);
      }
      const snapshot = await store.append(SESSION_ID, null, created.value);
      attachSession(context, snapshot);
    }

    await incumbent.shutdown('replaced');

    const replacement = await harness.bootCore({ instanceId: 'replacement' });
    const replacementCtx = makeInvocationContext(replacement.core.identity.pluginRoot);
    const replacementContext = replacement.core.getDiscussContext(replacementCtx);

    const rehydrated = getSession(replacementContext, SESSION_ID);
    if (!rehydrated) throw new Error(`replacement core did not rehydrate session ${SESSION_ID}`);
    expect(rehydrated.controller.signal.aborted).toBe(false);
    expect(rehydrated.snapshot.sessionId).toBe(SESSION_ID);
    expect(rehydrated.abortEnded).toBe(false);
  });

  it('binds recovered discuss dispatch to persisted account A rather than replacement defaults', async () => {
    const harness = createHandoffCoresHarness();
    harnesses.push(harness);

    const incumbent = await harness.bootCore({ instanceId: 'incumbent' });
    {
      const ctx = makeInvocationContext(incumbent.core.identity.pluginRoot);
      const source = incumbent.core.resolveProjectSource(PROJECT_ROOT);
      const store = incumbent.core.getDiscussStoreForSource(source);
      const context = incumbent.core.getDiscussContext(ctx);
      const agents = defaultAgents();
      const created = decideSessionCreate(
        { topic: TOPIC, agents, min_bid_delay_ms: 0 },
        { sessionId: SESSION_ID, projectRoot: PROJECT_ROOT, topic: TOPIC },
        1,
        SEED_TS,
        { agentExecution: defaultAgentExecution(agents), providerScope: TEST_PROVIDER_SCOPE },
      );
      if (!created.ok) throw new Error(`seed: decideSessionCreate failed: ${created.error}`);
      attachSession(context, await store.append(SESSION_ID, null, created.value));
    }
    await incumbent.shutdown('replaced');

    const serviceContexts: InvocationContext[] = [];
    const start = vi.fn(async () => ({ status: 'running' as const, job: 'recovered-job', session: 'recovered-agent' }));
    const replacement = await harness.bootCore({
      instanceId: 'replacement',
      createExecutionService: (ctx) => {
        serviceContexts.push(ctx);
        return {
          start,
          resume: start,
          waitStreamOnce: async () => ({ content: '', continuity: null }),
        } as never;
      },
    });
    const replacementInvocation = makeInvocationContext(replacement.core.identity.pluginRoot);
    const replacementContext = replacement.core.getDiscussContext(replacementInvocation);

    await replacementContext.service.start('codex', { prompt: 'recovered bid' }, replacementInvocation);

    expect(start).toHaveBeenCalledWith('codex', { prompt: 'recovered bid' }, replacementInvocation);
    expect(serviceContexts).toContainEqual(expect.objectContaining({ providerScope: TEST_PROVIDER_SCOPE }));
    expect(replacement.core.systemProviderScope).not.toEqual(TEST_PROVIDER_SCOPE);
  });
});
