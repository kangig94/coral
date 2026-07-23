import { describe, expect, it, vi } from 'vitest';
import { acquireProviderHostPin, releaseProviderHostPin } from '#src/coordinator/live/provider-hosts/lease.js';
import { maybeArmIdleTimer } from '#src/coordinator/live/provider-hosts/idle.js';
import {
  createEntry,
  createFakeProviderServerHandle,
  randomSequence,
  runtime,
} from '#tests/unit/coordinator/live/provider-hosts/helpers.js';

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
            if (entry.pinCount > 0) {
              evictedWhileHeld = true;
            }
          },
        });

      for (const step of randomSequence(seed)) {
        switch (step % 4) {
          case 0:
            acquireProviderHostPin(entry);
            break;
          case 1:
            if (entry.pinCount === 0) {
              acquireProviderHostPin(entry);
            } else {
              releaseProviderHostPin(entry);
            }
            arm();
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

        if (entry.pinCount > 0) {
          await vi.advanceTimersByTimeAsync(5);
          expect(evictedWhileHeld).toBe(false);
        }
      }
    }
  });
});
