import { isFinalWaitEvent, type WaitStreamEvent } from '#src/jobs/wait/contract.js';

/** The next event a client renders: cursor frames only move its frontier. */
export async function nextDelivered(stream: AsyncIterator<WaitStreamEvent>): Promise<IteratorResult<WaitStreamEvent>> {
  for (;;) {
    const next = await stream.next();
    if (next.done || next.value.type !== 'cursor') return next;
  }
}

export async function nextFinal(stream: AsyncIterator<WaitStreamEvent>): Promise<IteratorResult<WaitStreamEvent>> {
  for (;;) {
    const next = await stream.next();
    if (next.done || isFinalWaitEvent(next.value)) return next;
  }
}

export async function nextOfType<T extends WaitStreamEvent['type']>(
  stream: AsyncIterator<WaitStreamEvent>,
  type: T,
): Promise<Extract<WaitStreamEvent, { type: T }>> {
  for (;;) {
    const next = await stream.next();
    if (next.done) throw new Error(`Stream ended before a ${type} event`);
    if (next.value.type === type) return next.value as Extract<WaitStreamEvent, { type: T }>;
  }
}
