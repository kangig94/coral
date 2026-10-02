import { describe, expect, it } from 'vitest';

import { createMonotonicClock, type MonotonicClock } from '#src/infra/monotonic-clock.js';
import {
  createEnforcerDeadlineStateMachine,
  DEFAULT_PROVIDER_PROXY_ORPHAN_TIMEOUT_MS,
  PROXY_TEARDOWN_RESERVE_MS,
  resolveProviderProxyDeadlineConfiguration,
  type EnforcerChallengePolicy,
  type ProviderProxyDeadlineConfiguration,
} from '#src/provider-proxy/orphan-deadline.js';
import { createControlHolderAuthority, type ControlHolderAuthority } from '#src/provider-proxy/holder-lifecycle.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';

const guardianClockScope = Symbol('guardian-deadline-test');

function configuration(raw?: string): ProviderProxyDeadlineConfiguration {
  return resolveProviderProxyDeadlineConfiguration({
    get: () => raw,
  });
}

function createFakeClock<Scope extends symbol>(
  scope: Scope,
  initialMilliseconds: number,
): {
  readonly clock: MonotonicClock<Scope>;
  set(milliseconds: number): void;
} {
  let milliseconds = initialMilliseconds;
  return {
    clock: createMonotonicClock(scope, {
      readMilliseconds: () => BigInt(milliseconds),
      sleep: async (duration) => {
        milliseconds += duration;
      },
    }),
    set: (next) => {
      milliseconds = next;
    },
  };
}

/** A deterministic, prefix-tagged minter, so distinct machines in the same test never collide by accident. */
function policy(prefix: string): EnforcerChallengePolicy {
  let count = 0;
  return { mintChallenge: () => `${prefix}-${(count += 1)}` };
}

/** Narrows an `{ accepted }`-discriminated result, failing the test loudly instead of silently continuing. */
function mustAccept<T extends { accepted: boolean }>(result: T): Extract<T, { accepted: true }> {
  if (!result.accepted) throw new Error(`Expected acceptance, got ${JSON.stringify(result)}`);
  return result as Extract<T, { accepted: true }>;
}

function installedHolder(): ControlHolderAuthority {
  const authority = createControlHolderAuthority();
  authority.install({
    controlEpoch: 1,
    holder: { instanceId: 'coordinator', pid: 4_000, incarnation: testIncarnation('coordinator') },
  });
  return authority;
}

describe('AC5 — a late heartbeat from a recovering coordinator is accepted once a holder is published', () => {
  it('stops latching teardown from elapsed time once the holder authority is published', () => {
    const fake = createFakeClock(guardianClockScope, 0);
    const authority = installedHolder();
    authority.publish();
    const guardian = createEnforcerDeadlineStateMachine(fake.clock, configuration(), policy('c'), authority);
    const first = mustAccept(guardian.issueFirstChallenge());
    // A published holder must not latch teardown without enforcement authorization.
    fake.set(DEFAULT_PROVIDER_PROXY_ORPHAN_TIMEOUT_MS - PROXY_TEARDOWN_RESERVE_MS + 5_000);

    const echoed = guardian.echoChallenge(first.challenge);

    expect(echoed).toEqual({ accepted: true, nextChallenge: expect.any(String) });
    expect(guardian.state()).toBe('accepting-control');
  });
});

it('advances the enforcer deadlines on every accepted echo', () => {
  const fake = createFakeClock(guardianClockScope, 0);
  const deadlines = createEnforcerDeadlineStateMachine(fake.clock, configuration(), policy('echo'), installedHolder());
  const before = deadlines.bounds();
  const opening = mustAccept(deadlines.issueFirstChallenge());
  fake.set(3_000);

  const beat = mustAccept(deadlines.echoChallenge(opening.challenge));

  expect(beat.nextChallenge).not.toBe(opening.challenge);
  const after = deadlines.bounds();
  expect(fake.clock.compare(after.adoptionDeadline, before.adoptionDeadline)).toBe(1);
  expect(fake.clock.compare(after.exitDeadline, before.exitDeadline)).toBe(1);
});
