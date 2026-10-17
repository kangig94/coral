import { describe, expect, it, vi } from 'vitest';

import type { AppServerTransport, ProviderSendOutcome } from '#src/providers/contract.js';
import { snapshotImplementation } from '#src/providers/internal/definition-boundary.js';
import { codexAppServerLifecycle } from '#src/providers/codex/provider-facets.js';
import { codexTurnKernel } from '#src/providers/codex/thread-kernel.js';
import { buildCodexExecutionPlan } from '#src/providers/codex/execution-plan.js';

const INPUT = { text: 'Change direction', clientMessageId: '33333333-3333-4333-8333-333333333333' };
const CONTINUITY = { threadId: 'thread-1', turnId: 'turn-1' };
const TRANSPORT: AppServerTransport = {
  rpc: async <R>() => ({}) as R,
  subscribe: () => () => {},
  closed: new Promise(() => {}),
};

function capability(send: NonNullable<typeof codexAppServerLifecycle.send>) {
  const implementation = snapshotImplementation({
    name: 'codex',
    transport: 'app-server',
    run: codexTurnKernel,
    prepareExecutionPlan: buildCodexExecutionPlan,
    appServer: { ...codexAppServerLifecycle, send },
  });
  if (implementation.transport !== 'app-server') throw new Error('Expected app-server implementation');
  return implementation.appServer;
}

describe('snapshotImplementation send', () => {
  it('preserves the facet receiver and snapshots continuity and input before provider code', async () => {
    let receiverName: string | undefined;
    const send = vi.fn(async function (
      this: { name: string },
      transport,
      continuity,
      input,
    ): Promise<ProviderSendOutcome> {
      receiverName = this.name;
      expect(transport).not.toBe(TRANSPORT);
      expect(continuity).toEqual(CONTINUITY);
      expect(continuity).not.toBe(CONTINUITY);
      expect(input).toEqual(INPUT);
      expect(input).not.toBe(INPUT);
      return { state: 'delivered' };
    } satisfies NonNullable<typeof codexAppServerLifecycle.send>);
    await expect(capability(send).send!(TRANSPORT, CONTINUITY, INPUT)).resolves.toEqual({ state: 'delivered' });
    expect(receiverName).toBe('codex');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each([{ state: 'delivered', extra: true }, { state: 'refused', code: 'provider_rejected' }, { state: 'unknown' }])(
    'rejects invalid provider outcomes at the definition boundary: %j',
    async (outcome) => {
      const send = vi.fn(async () => outcome as unknown as ProviderSendOutcome);
      await expect(capability(send).send!(TRANSPORT, CONTINUITY, INPUT)).rejects.toThrow();
    },
  );

  it('validates caller correlation before invoking the provider facet', async () => {
    const send = vi.fn(async (): Promise<ProviderSendOutcome> => ({ state: 'delivered' }));
    await expect(
      capability(send).send!(TRANSPORT, CONTINUITY, { ...INPUT, clientMessageId: 'bad-id' }),
    ).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });
});
