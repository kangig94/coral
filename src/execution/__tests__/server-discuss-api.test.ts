import { afterEach, describe, expect, it, vi } from 'vitest';
import { request as httpRequest, type IncomingMessage as ClientIncomingMessage } from 'node:http';

import { makeEvent } from '../../discuss/events.js';
import type { DiscussDetailResponse } from '../../client/discuss.js';
import { DiscussManagerRegistry } from '../discuss-manager.js';
import type { BackendServerController } from '../server.js';
import { createBackendServer } from '../server.js';
import {
  cleanupDiscussHarnesses,
  createDiscussHarness,
  createExecutionServiceStub,
  persistSession,
} from './discuss-test-helpers.js';

type HttpStream = {
  response: ClientIncomingMessage;
  waitForText: (check: (text: string) => boolean, timeoutMs?: number) => Promise<string>;
  close: () => void;
};

function extractSsePayload(text: string, eventName: string): Record<string, unknown> | null {
  const blocks = text.split('\n\n');
  for (const block of blocks) {
    if (!block.includes(`event: ${eventName}`)) {
      continue;
    }
    const dataLine = block.split('\n').find((line) => line.startsWith('data: '));
    if (!dataLine) {
      continue;
    }
    return JSON.parse(dataLine.slice(6)) as Record<string, unknown>;
  }
  return null;
}

async function openHttpStream(url: string, headers: Record<string, string>): Promise<HttpStream> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { headers });
    req.once('error', reject);
    req.once('response', (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        text += chunk;
      });

      const waitForText = (check: (current: string) => boolean, timeoutMs = 2_000): Promise<string> => {
        if (check(text)) {
          return Promise.resolve(text);
        }

        return new Promise<string>((resolveText, rejectText) => {
          const timeout = setTimeout(() => {
            cleanup();
            rejectText(new Error('Timed out reading stream'));
          }, timeoutMs);

          const onData = () => {
            if (!check(text)) {
              return;
            }
            cleanup();
            resolveText(text);
          };
          const onEnd = () => {
            cleanup();
            rejectText(new Error('Stream ended before expected data arrived'));
          };
          const onError = (error: Error) => {
            cleanup();
            rejectText(error);
          };
          const cleanup = () => {
            clearTimeout(timeout);
            response.off('data', onData);
            response.off('end', onEnd);
            response.off('error', onError);
          };

          response.on('data', onData);
          response.once('end', onEnd);
          response.once('error', onError);
        });
      };

      resolve({
        response,
        waitForText,
        close: () => {
          req.destroy();
          response.destroy();
        },
      });
    });
    req.end();
  });
}

describe('server discuss API', () => {
  let controller: BackendServerController | null = null;

  afterEach(async () => {
    if (controller && controller.getLifecycle() !== 'stopped') {
      try {
        await controller.shutdown('test');
      } catch {
        /* best effort */
      }
    }
    controller = null;
    cleanupDiscussHarnesses();
    vi.restoreAllMocks();
  });

  async function startServer(
    projectRoot: string,
    registry: DiscussManagerRegistry,
    service = createExecutionServiceStub(),
  ): Promise<{ baseUrl: string; token: string; registry: DiscussManagerRegistry }> {
    controller = createBackendServer({
      instanceId: 'server-discuss-api-test',
      token: 'test-token',
      version: '9.9.9',
      bundleHash: 'test-hash',
      log: () => {},
      discussRegistry: registry,
      createExecutionService: () => service as never,
    });
    const started = await controller.start();
    return {
      baseUrl: `http://127.0.0.1:${started.port}`,
      token: started.token,
      registry,
    };
  }

  it('serves control and audit detail views from the committed snapshot contract', async () => {
    const harness = createDiscussHarness();
    await persistSession(harness, {
      sessionId: 'ended-session',
      buildTail: (current) => [
        makeEvent(current.sessionId, harness.projectRoot, current.state.topic, current.lastAppliedSeq + 1, 'bid.submitted', '2026-03-11T00:01:00.000Z', {
          agent: 'alpha',
          score: 88,
          thought: 'keep sealed',
        }),
        makeEvent(current.sessionId, harness.projectRoot, current.state.topic, current.lastAppliedSeq + 2, 'bid.submitted', '2026-03-11T00:01:01.000Z', {
          agent: 'beta',
          score: 42,
          thought: 'also sealed',
        }),
        makeEvent(current.sessionId, harness.projectRoot, current.state.topic, current.lastAppliedSeq + 3, 'bid.round.closed', '2026-03-11T00:01:02.000Z', {
          allBids: { alpha: 88, beta: 42 },
          effectiveBids: { alpha: 88, beta: 42 },
          thoughts: { alpha: 'keep sealed', beta: 'also sealed' },
          outcome: { winner: 'alpha', speaker_type: 'quota' as const },
          stateMutations: { cold_start: false },
        }),
        makeEvent(current.sessionId, harness.projectRoot, current.state.topic, current.lastAppliedSeq + 4, 'speech.recorded', '2026-03-11T00:01:03.000Z', {
          agent: 'alpha',
          content: 'Open the street to buses and bikes first.',
          decrementQuota: true,
          recordLastSpeechStep: 1,
        }),
        makeEvent(current.sessionId, harness.projectRoot, current.state.topic, current.lastAppliedSeq + 5, 'session.ended', '2026-03-11T00:01:04.000Z', {
          endReason: 'all_below_threshold',
          endReasonContent: 'Consensus reached.',
        }),
        makeEvent(current.sessionId, harness.projectRoot, current.state.topic, current.lastAppliedSeq + 6, 'session.synthesized', '2026-03-11T00:01:05.000Z', {
          synthesis: 'Build the transit-first pilot and measure results.',
        }),
      ],
    });

    await persistSession(harness, {
      sessionId: 'live-session',
      agents: [
        { name: 'alpha', persona: '# Alpha', participation: 'required' },
        { name: 'user', persona: '# User', participation: 'observer' },
      ],
      buildTail: (current) => [
        makeEvent(current.sessionId, harness.projectRoot, current.state.topic, current.lastAppliedSeq + 1, 'bid.submitted', '2026-03-11T00:02:00.000Z', {
          agent: 'alpha',
          score: 40,
          thought: 'alpha',
        }),
        makeEvent(current.sessionId, harness.projectRoot, current.state.topic, current.lastAppliedSeq + 2, 'bid.submitted', '2026-03-11T00:02:01.000Z', {
          agent: 'user',
          score: 80,
          thought: 'user',
        }),
        makeEvent(current.sessionId, harness.projectRoot, current.state.topic, current.lastAppliedSeq + 3, 'bid.round.closed', '2026-03-11T00:02:02.000Z', {
          allBids: { alpha: 40, user: 80 },
          effectiveBids: { alpha: 40, user: 80 },
          thoughts: { alpha: 'alpha', user: 'user' },
          outcome: { winner: 'user', speaker_type: 'quota' as const },
          stateMutations: { cold_start: false },
        }),
      ],
    });

    const backend = await startServer(harness.projectRoot, new DiscussManagerRegistry(), harness.service);

    const controlResponse = await fetch(
      `${backend.baseUrl}/api/discuss/detail?projectRoot=${encodeURIComponent(harness.projectRoot)}&sessionId=ended-session`,
      { headers: { 'X-Coral-Backend-Token': backend.token } },
    );
    const controlBody = await controlResponse.json() as DiscussDetailResponse;

    expect(controlResponse.status).toBe(200);
    expect(controlBody.view).toBe('control');
    expect(controlBody.authority).toBe('live');
    expect(Array.isArray(controlBody.transcript)).toBe(true);
    expect('transcript' in controlBody.session).toBe(false);
    expect(controlBody.transcript.find((entry) => entry.type === 'bids')).toEqual({
      type: 'bids',
      step: 1,
      epoch: 1,
      ts: '2026-03-11T00:01:02.000Z',
      winner: 'alpha',
      resolve_type: 'normal',
    });
    expect(JSON.stringify(controlBody.transcript)).not.toContain('keep sealed');

    const auditResponse = await fetch(
      `${backend.baseUrl}/api/discuss/detail?projectRoot=${encodeURIComponent(harness.projectRoot)}&sessionId=ended-session&view=audit`,
      { headers: { 'X-Coral-Backend-Token': backend.token } },
    );
    const auditBody = await auditResponse.json() as DiscussDetailResponse;

    expect(auditResponse.status).toBe(200);
    expect(auditBody.view).toBe('audit');
    expect(auditBody.transcript.find((entry) => entry.type === 'bids')).toMatchObject({
      type: 'bids',
      bids: { alpha: 88, beta: 42 },
      effective_bids: { alpha: 88, beta: 42 },
      thoughts: { alpha: 'keep sealed', beta: 'also sealed' },
    });

    const liveAuditResponse = await fetch(
      `${backend.baseUrl}/api/discuss/detail?projectRoot=${encodeURIComponent(harness.projectRoot)}&sessionId=live-session&view=audit`,
      { headers: { 'X-Coral-Backend-Token': backend.token } },
    );

    expect(liveAuditResponse.status).toBe(409);
    expect(await liveAuditResponse.json()).toEqual({
      error: 'audit_requires_ended_session',
    });
  });

  it('emits discuss:updated over SSE and detail reads observe the emitted lastSeq', async () => {
    const harness = createDiscussHarness();
    await persistSession(harness, {
      sessionId: 'manual-live-session',
      agents: [
        { name: 'alpha', persona: '# Alpha', participation: 'required' },
        { name: 'user', persona: '# User', participation: 'observer' },
      ],
      buildTail: (current) => [
        makeEvent(current.sessionId, harness.projectRoot, current.state.topic, current.lastAppliedSeq + 1, 'bid.submitted', '2026-03-11T00:03:00.000Z', {
          agent: 'alpha',
          score: 40,
          thought: 'alpha',
        }),
        makeEvent(current.sessionId, harness.projectRoot, current.state.topic, current.lastAppliedSeq + 2, 'bid.submitted', '2026-03-11T00:03:01.000Z', {
          agent: 'user',
          score: 80,
          thought: 'user',
        }),
        makeEvent(current.sessionId, harness.projectRoot, current.state.topic, current.lastAppliedSeq + 3, 'bid.round.closed', '2026-03-11T00:03:02.000Z', {
          allBids: { alpha: 40, user: 80 },
          effectiveBids: { alpha: 40, user: 80 },
          thoughts: { alpha: 'alpha', user: 'user' },
          outcome: { winner: 'user', speaker_type: 'quota' as const },
          stateMutations: { cold_start: false },
        }),
      ],
    });

    const registry = new DiscussManagerRegistry();
    const backend = await startServer(harness.projectRoot, registry, harness.service);
    const manager = registry.get(harness.projectRoot);
    if (!manager) {
      throw new Error('Expected recovered discuss manager');
    }

    vi.spyOn(
      manager as unknown as {
        resumeLoop(targetSessionId: string, targetCtx: typeof harness.ctx): void;
      },
      'resumeLoop',
    ).mockImplementation(() => {});

    const stream = await openHttpStream(`${backend.baseUrl}/events/stream`, {
      'X-Coral-Backend-Token': backend.token,
    });

    try {
      await stream.waitForText((text) => text.includes('event: ready'));
      await manager.submitManualSpeech(
        'manual-live-session',
        'user',
        'I will take the floor manually.',
        harness.ctx,
      );

      const eventText = await stream.waitForText((text) => text.includes('event: discuss:updated'));
      const payload = extractSsePayload(eventText, 'discuss:updated');

      expect(payload).toEqual({
        projectRoot: harness.projectRoot,
        sessionId: 'manual-live-session',
        lastSeq: harness.store.load('manual-live-session')?.lastAppliedSeq,
        status: harness.store.load('manual-live-session')?.state.status,
      });

      const detailResponse = await fetch(
        `${backend.baseUrl}/api/discuss/detail?projectRoot=${encodeURIComponent(harness.projectRoot)}&sessionId=manual-live-session`,
        { headers: { 'X-Coral-Backend-Token': backend.token } },
      );
      const detailBody = await detailResponse.json() as DiscussDetailResponse;

      expect(detailResponse.status).toBe(200);
      expect(detailBody.lastSeq).toBe(payload?.lastSeq);
    } finally {
      stream.close();
    }
  });
});
