import { describe, expect, it } from 'vitest';

import {
  boundCoordinatorAuthorityFrom,
  type BoundCoordinatorAuthority,
} from '#src/coordinator/bound-coordinator-authority.js';
import { bindWithHandoff, type HandoffOptions } from '#src/coordinator/handoff.js';
import type { RunStartupRecoveryFn, StartupRecoveryDeps } from '#src/coordinator/lifecycle.js';
import type { Runtime } from '#src/runtime/ports.js';

function compileTimeAssertions(): void {
  const acceptAuthority = (_authority: BoundCoordinatorAuthority): void => {};
  // @ts-expect-error A structural object cannot stand in for bind authority.
  acceptAuthority({});

  // @ts-expect-error Authority derivation requires the successful bind result.
  boundCoordinatorAuthorityFrom();
  // @ts-expect-error A structural lookalike is not a successful bind result.
  boundCoordinatorAuthorityFrom({ acquiredViaHandoff: false });

  const runStartupRecovery: RunStartupRecoveryFn = async () => [];
  const depsWithoutAuthority = {} as Omit<StartupRecoveryDeps, 'boundCoordinatorAuthority'>;
  // @ts-expect-error Startup recovery cannot be invoked without bind authority.
  void runStartupRecovery(depsWithoutAuthority);
}

void compileTimeAssertions;

function successfulBind() {
  const options: HandoffOptions = {
    socketPath: '/tmp/coral-bound-authority.sock',
    desired: { version: '1.0.0', bundleHash: 'bundle', flavor: 'prod', namespace: 'namespace' },
    bindAttempt: async () => ({ kind: 'bound' }),
    runtime: {
      time: { now: () => 0 } as unknown as Runtime['time'],
      process: {} as Runtime['process'],
      env: { platform: () => 'linux' } as unknown as Runtime['env'],
    },
    readVerifiedIncumbentFromDiscovery: () => null,
    totalBudgetMs: 1,
  };
  return bindWithHandoff(options);
}

describe('bound-coordinator-authority', () => {
  it('should derive one opaque authority from a successful bind result', async () => {
    const bindResult = await successfulBind();

    const authority = boundCoordinatorAuthorityFrom(bindResult);

    expect(Object.isFrozen(authority)).toBe(true);
    expect(Object.keys(authority)).toEqual([]);
    expect(boundCoordinatorAuthorityFrom(bindResult)).toBe(authority);
  });

  it('should keep authorities distinct across successful bind results', async () => {
    const first = boundCoordinatorAuthorityFrom(await successfulBind());
    const second = boundCoordinatorAuthorityFrom(await successfulBind());

    expect(first).not.toBe(second);
  });
});
