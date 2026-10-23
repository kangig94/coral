import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerProviderCommands } from '#src/cli/commands/provider.js';
import * as dispatch from '#src/cli/dispatch.js';
import type { AcceptedLaunchResponse } from '#src/jobs/launch.js';
import { conversationIdentityFixture } from '#tests/integration/jobs/conversation-identity-fixture.js';

afterEach(() => vi.restoreAllMocks());

describe('CLI provider conversation identity', () => {
  it.each(['codex', 'claude'])('keeps the %s launch jobId through consecutive executions', async (provider) => {
    const f = conversationIdentityFixture();
    const decisions: AcceptedLaunchResponse[] = [];
    const createSession: ReturnType<typeof dispatch.makeClient>['createSession'] = async (name, prompt, options) => {
      const launched = await f.service.start(name, { prompt, retention: options?.retention }, f.ctx);
      if (launched.status !== 'running' && launched.status !== 'queued') throw new Error(launched.message);
      const response: AcceptedLaunchResponse = {
        kind: 'provider-session',
        jobId: launched.jobId,
        requestedSeq: launched.requestedSeq,
        epochKey: launched.epochKey,
        launchState: launched.status,
      };
      decisions.push(response);
      return response;
    };
    vi.spyOn(dispatch, 'makeClient').mockReturnValue({ createSession } as ReturnType<typeof dispatch.makeClient>);
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const program = new Command();
    registerProviderCommands(program, f.providers);

    try {
      await f.drive(program.parseAsync([provider, '-i', 'first input', '-d'], { from: 'user' }));
      expect(decisions).toHaveLength(1);
      const first = decisions[0];
      await f.drive(f.service.waitForJobTerminal(first.jobId, 10_000));
      for (const execution of [2, 3]) {
        const continuation = {
          jobId: first.jobId,
          prompt: `input #${execution}`,
          originatingClientMessageId: `cli-message-${execution}`,
        };
        const resumed = await f.drive(f.service.resume(provider, continuation, f.ctx));
        expect(resumed).toMatchObject({ jobId: first.jobId, status: 'running' });
        expect(resumed).not.toHaveProperty('executionId');
        await f.drive(f.service.waitForJobTerminal(first.jobId, 10_000));
      }

      expect(first).not.toHaveProperty('executionId');
      expect(first).not.toHaveProperty('sessionId');
      expect(stdout.mock.calls.map(([chunk]) => String(chunk)).join('')).toContain(first.jobId);
      expect(f.store.listJobIds()).toEqual([first.jobId]);
      f.assertIdentity(first.jobId, [1, 2, 3]);
    } finally {
      await f.dispose();
    }
  });
});
