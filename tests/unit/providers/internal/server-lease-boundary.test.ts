import { describe, expect, it, vi } from 'vitest';

import type { AppServerSession, ProviderSendOutcome } from '#src/providers/contract.js';
import { wrapAppServerSession } from '#src/providers/internal/server-lease-boundary.js';

const INPUT = { text: 'Change direction', clientMessageId: '33333333-3333-4333-8333-333333333333' };
const CONTINUITY = { threadId: 'thread-1', turnId: 'turn-1' };

function session(send?: AppServerSession['send']): AppServerSession {
  return {
    rpc: async <R>() => ({}) as R,
    subscribe: () => () => {},
    closed: new Promise(() => {}),
    interrupt: async () => ({ kind: 'accepted' }),
    ...(send === undefined ? {} : { send }),
  };
}

describe('wrapAppServerSession send', () => {
  it.each<ProviderSendOutcome>([
    { state: 'delivered' },
    { state: 'refused', code: 'provider_rejected', reason: 'Provider wording' },
    { state: 'unknown', reason: 'No answer' },
  ])('preserves the validated $state outcome and snapshots the caller input', async (outcome) => {
    const send = vi.fn((async (continuity, input) => {
      expect(continuity).not.toBe(CONTINUITY);
      expect(input).not.toBe(INPUT);
      return outcome;
    }) satisfies NonNullable<AppServerSession['send']>);
    const wrapped = wrapAppServerSession(session(send), 'Test session');
    await expect(wrapped.send!(CONTINUITY, INPUT)).resolves.toEqual(outcome);
    expect(send).toHaveBeenCalledExactlyOnceWith(CONTINUITY, INPUT);
  });

  it.each([
    { state: 'delivered', extra: true },
    { state: 'refused', code: 'not_steerable', reason: 'Unsupported code' },
    { state: 'refused', code: 'provider_rejected' },
    { state: 'unknown' },
    { kind: 'accepted' },
    null,
  ])('rejects a malformed send outcome instead of inventing delivery: %j', async (outcome) => {
    const send = vi.fn(async () => outcome as unknown as ProviderSendOutcome);
    await expect(wrapAppServerSession(session(send), 'Test session').send!(CONTINUITY, INPUT)).rejects.toThrow();
  });

  it('refuses an absent send capability without calling RPC', async () => {
    const raw = session();
    const rpc = vi.spyOn(raw, 'rpc');
    await expect(wrapAppServerSession(raw, 'Test session').send!(CONTINUITY, INPUT)).resolves.toMatchObject({
      state: 'refused',
      code: 'transport_unsupported',
    });
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([
    { ...INPUT, text: '' },
    { ...INPUT, clientMessageId: 'bad-id' },
  ])('rejects malformed input before invoking send: %j', async (input) => {
    const send = vi.fn(async (): Promise<ProviderSendOutcome> => ({ state: 'delivered' }));
    await expect(wrapAppServerSession(session(send), 'Test session').send!(CONTINUITY, input)).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });

  it('rejects a send accessor without invoking it', () => {
    const getter = vi.fn();
    const raw = session();
    Object.defineProperty(raw, 'send', { get: getter });
    expect(() => wrapAppServerSession(raw, 'Test session')).toThrow('must be a data property');
    expect(getter).not.toHaveBeenCalled();
  });
});
