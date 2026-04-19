import { describe, expect, it, vi } from 'vitest';
import { acquireSharedProviderServerLease, releaseSharedProviderServerLease } from '../lease.js';
import { maybeArmIdleTimer } from '../idle.js';
import { createEntry, createFakeProviderServerHandle, randomSequence, runtime } from './helpers.js';

describe('provider host idle properties', () => {
  it('never evicts a currently-acquired lease across 100 random idle sequences', async () => {
    vi.useFakeTimers();

    for (let seed = 1; seed <= 100; seed += 1) {
      const server = createFakeProviderServerHandle();
      const entry = createEntry({
        handle: server.handle,
        hostStats: { liveControllers: 0, activeTurns: 0 },
      });
      const entries = new Map([[entry.hostKey, entry]]);
      let evictedWhileHeld = false;

      const arm = () =>
        maybeArmIdleTimer(entry, {
          runtime,
          idleTimeoutMs: 5,
          entries,
          closeProviderServerEntry: async () => {
            if (entry.sharedLeaseCount > 0) {
              evictedWhileHeld = true;
            }
          },
        });

      for (const step of randomSequence(seed)) {
        switch (step % 4) {
          case 0:
            acquireSharedProviderServerLease(entry);
            break;
          case 1:
            releaseSharedProviderServerLease(entry, () => arm());
            break;
          case 2:
            arm();
            await vi.advanceTimersByTimeAsync(5);
            break;
          default:
            entry.hostStats = {
              liveControllers: step % 3 === 0 ? 1 : 0,
              activeTurns: step % 5 === 0 ? 1 : 0,
            };
            arm();
            break;
        }

        if (entry.sharedLeaseCount > 0) {
          await vi.advanceTimersByTimeAsync(5);
          expect(evictedWhileHeld).toBe(false);
        }
      }
    }
  });
});
