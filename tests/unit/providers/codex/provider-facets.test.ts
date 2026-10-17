import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TEST_CODEX_ACCESS } from '../../../helpers/provider-credentials.js';
import {
  codexAppServerLifecycle,
  codexPreflight,
  codexRecoveryLifecycle,
} from '#src/providers/codex/provider-facets.js';
import { buildCodexContinuity } from '#src/providers/codex/request-mapping.js';
import { ProviderRpcError } from '#src/providers/app-server-transport.js';
import { ProviderHostUnserviceableResponseError } from '#src/providers/host-admission.js';
import { createDeferred } from '#tools/testing/deferred.js';
import { VirtualTime, flushMicrotasks } from '#tools/simulation/core/virtual-time.js';
import type { AppServerTransport } from '#src/providers/contract.js';
import { jsonValueSchema } from '#src/infra/json-value.js';
import type { ProviderPreflightRuntime } from '#src/providers/contract.js';
import type { CodexProviderAccess } from '#src/providers/codex/execution-plan.js';

describe('codexRecoveryLifecycle.finalizeInterrupted', () => {
  it('emits continuity the durable JSON boundary accepts', () => {
    // Production hands this mutation's continuity to `jsonValueSchema.parse` in
    // `providers/internal/bound-provider.ts`. JSON has no `undefined`, so a key that exists with an
    // undefined value is rejected there — and the throw lands inside recovery adoption, where it used
    // to terminalize the job. `toEqual` cannot see this: it ignores undefined-valued properties, which
    // is why every existing case here passed while the boundary rejected the same object.
    const continuity = buildCodexContinuity({ cwd: '/workspace', threadId: 'thread-1' });

    const mutation = codexRecoveryLifecycle.finalizeInterrupted(
      { resumable: true, updatedContinuity: continuity },
      continuity,
      {},
    );

    const emitted = 'providerContinuity' in mutation ? mutation.providerContinuity : undefined;
    expect(emitted).toBeDefined();
    expect(Object.keys(emitted as object)).toStrictEqual(['cwd', 'threadId']);
    expect(() => jsonValueSchema.parse(emitted)).not.toThrow();
  });
});

// `codexPreflight` had no tests. Both of its checks answered every failure with the remedy for the one cause
// they could name — "update the Codex CLI", "run codex login" — so a fork that lost to EAGAIN and an
// `auth.json` this process may not open were reported as an outdated CLI and an unauthenticated account. Both
// verdicts are also cached for a minute, so the wrong sentence is repeated without re-checking.
describe('codexPreflight', () => {
  const UPGRADE = /npm update -g @openai\/codex/u;
  const LOGIN = /Run "codex login"/u;
  const TOKENS = JSON.stringify({ tokens: { access_token: 'live-token' } });

  let clock = 1_700_000_000_000;
  beforeEach(() => {
    clock += 120_000;
  });

  function errno(code: string): Error {
    return Object.assign(new Error(code), { code });
  }

  function preflightRuntime(options: {
    appServer?: { status?: number | null; error?: Error };
    authFile?: string | Error;
    home?: string;
    cwd?: string;
    cwdState?: 'directory' | 'missing' | 'not-directory' | 'unobserved';
    cwdTraversability?: 'traversable' | 'denied' | 'unobserved';
    statSync?: ReturnType<typeof vi.fn>;
  }): ProviderPreflightRuntime<CodexProviderAccess> & { runExact: ReturnType<typeof vi.fn> } {
    const appServer = options.appServer ?? { status: 0 };
    const authFile = options.authFile ?? TOKENS;
    const cwdState = options.cwdState ?? 'directory';
    const statSync =
      options.statSync ??
      vi.fn(() => {
        if (cwdState === 'missing') throw errno('ENOENT');
        if (cwdState === 'unobserved') throw errno('EACCES');
        return {
          size: 0,
          mtimeMs: 0,
          isDirectory: () => cwdState === 'directory',
          isFile: () => cwdState === 'not-directory',
        };
      });
    return {
      access: { home: options.home ?? TEST_CODEX_ACCESS.home },
      cwd: options.cwd ?? '/workspace/project',
      storage: {
        readFileSync: () => {
          if (authFile instanceof Error) throw authFile;
          return authFile;
        },
        statSync,
        observeDirectoryTraversabilitySync: () => options.cwdTraversability ?? 'traversable',
      },
      time: { now: () => clock },
      runExact: vi.fn(async () => ({
        stdout: '',
        stderr: '',
        status: appServer.status ?? null,
        ...(appServer.error === undefined ? {} : { error: appServer.error }),
      })),
    } as unknown as ProviderPreflightRuntime<CodexProviderAccess> & { runExact: ReturnType<typeof vi.fn> };
  }

  it('accepts a Codex CLI that answers and a home that holds tokens', async () => {
    await expect(codexPreflight(preflightRuntime({}))).resolves.toEqual({ kind: 'satisfied' });
  });

  it.each([['EAGAIN']])('does not blame the installed CLI when the probe failed on %s', async (code) => {
    const runtime = preflightRuntime({ appServer: { error: errno(code), status: null } });

    const outcome = await codexPreflight(runtime);

    expect(outcome).toEqual({ kind: 'undetermined', message: expect.stringMatching(/could not complete/iu) });
    if (outcome.kind !== 'undetermined') throw new Error('expected undetermined');
    expect(outcome.message).not.toMatch(UPGRADE);
  });

  it('reports ENOENT only as a Codex command that could not start after verifying the working directory', async () => {
    const statSync = vi.fn(() => ({ isDirectory: () => true }));
    const runtime = preflightRuntime({ appServer: { error: errno('ENOENT'), status: null }, statSync });
    const outcome = await codexPreflight(runtime);

    expect(outcome).toEqual({
      kind: 'refused',
      message:
        "Coral could not start `codex` using the Coral daemon's PATH (ENOENT); ensure `codex` is installed and runnable at a location on that PATH, and restart the Coral backend after changing that PATH before retrying.",
    });
    if (outcome.kind !== 'refused') throw new Error('expected refused');
    expect(statSync).toHaveBeenCalledWith(runtime.cwd);
    expect(outcome.message).not.toMatch(/could not find|not found/iu);
    expect(outcome.message).toMatch(/restart the Coral backend/iu);
    expect(outcome.message).not.toMatch(UPGRADE);
  });

  it('reports a CLI without the subcommand as one to update', async () => {
    await expect(codexPreflight(preflightRuntime({ appServer: { status: 1 } }))).resolves.toEqual({
      kind: 'refused',
      message: expect.stringMatching(UPGRADE),
    });
  });

  it('reports an absent auth.json as an unauthenticated account', async () => {
    const runtime = preflightRuntime({ authFile: errno('ENOENT'), home: `/home/user/.codex-a-${clock}` });

    await expect(codexPreflight(runtime)).resolves.toEqual({
      kind: 'refused',
      message: expect.stringMatching(LOGIN),
    });
  });

  it('does not tell an operator to log in when auth.json could not be read at all', async () => {
    // `codex login` writes this file; it does not grant the daemon permission to read it afterwards, so the
    // remedy does not apply and must not be offered.
    const runtime = preflightRuntime({ authFile: errno('EACCES'), home: `/home/user/.codex-c-${clock}` });

    const outcome = await codexPreflight(runtime);

    expect(outcome).toEqual({ kind: 'undetermined', message: expect.stringMatching(/could not read/iu) });
    if (outcome.kind !== 'undetermined') throw new Error('expected undetermined');
    expect(outcome.message).not.toMatch(LOGIN);
  });
});

describe('codexAppServerLifecycle.send', () => {
  const input = { text: 'Change direction', clientMessageId: '33333333-3333-4333-8333-333333333333' };
  const continuity = buildCodexContinuity({ cwd: '/workspace', threadId: 'thread-1', turnId: 'turn-1' });

  function transport(rpc: ReturnType<typeof vi.fn>): AppServerTransport {
    return { rpc: rpc as AppServerTransport['rpc'], subscribe: () => () => {}, closed: new Promise(() => {}) };
  }

  function providerError(code: number, message: string): ProviderRpcError {
    return new ProviderRpcError({
      requestId: 5,
      method: 'turn/steer',
      rpcCode: code,
      providerMessage: message,
      providerData: undefined,
      hostLog: { startSeq: 1, endSeq: 2 },
    });
  }

  it('delivers once to the retained expectedTurnId with the send correlation id', async () => {
    const rpc = vi.fn(async () => ({ turnId: 'turn-1' }));
    await expect(codexAppServerLifecycle.send!(transport(rpc), continuity, input)).resolves.toEqual({
      state: 'delivered',
    });
    expect(rpc).toHaveBeenCalledExactlyOnceWith('turn/steer', {
      threadId: 'thread-1',
      expectedTurnId: 'turn-1',
      clientUserMessageId: input.clientMessageId,
      input: [{ type: 'text', text: input.text, text_elements: [] }],
    });
  });

  it.each([
    [
      -32600,
      'expected active turn id `00000000-0000-4000-8000-000000000000` but found `01a14a38-dda3-75a2-962e-a2ad3411a930`',
      'turn_ended',
    ],
    [-32600, 'no active turn to steer', 'turn_ended'],
    [-32600, 'invalid request: input is empty', 'provider_rejected'],
    [-32600, 'active review turn is not steerable', 'provider_rejected'],
    [-32600, 'expected active turn id is invalid', 'provider_rejected'],
    [-32000, 'no active turn to steer', 'provider_rejected'],
    [-32603, 'provider internal failure', 'provider_rejected'],
    [-32601, 'Method not found', 'provider_rejected'],
  ])('maps answered error %s / %s to %s without requiring data', async (code, message, expectedCode) => {
    const rpc = vi.fn(async () => {
      throw providerError(code, message);
    });
    await expect(codexAppServerLifecycle.send!(transport(rpc), continuity, input)).resolves.toEqual({
      state: 'refused',
      code: expectedCode,
      reason: message,
    });
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('preserves an answered rejection when the live host wrapper correlates it with host serviceability', async () => {
    const rejection = providerError(-32600, 'no active turn to steer');
    const rpc = vi.fn(async () => {
      throw new ProviderHostUnserviceableResponseError(
        {
          provider: 'codex',
          fingerprint: 'host',
          instanceId: 'instance',
          leaseMode: 'shared',
        },
        rejection,
      );
    });
    await expect(codexAppServerLifecycle.send!(transport(rpc), continuity, input)).resolves.toEqual({
      state: 'refused',
      code: 'turn_ended',
      reason: 'no active turn to steer',
    });
  });

  it('reports a timed out provider request as unknown without replay', async () => {
    const time = new VirtualTime();
    const answer = createDeferred<never>();
    const rpc = vi.fn(() => answer.promise);
    const pending = codexAppServerLifecycle.send!(transport(rpc), continuity, input);
    time.setTimeout(() => answer.reject(new Error('provider request timed out')), 10_000);
    time.tick(10_000);
    await expect(pending).resolves.toEqual({ state: 'unknown', reason: 'provider request timed out' });
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('waits for a missing answer without inventing a refusal', async () => {
    const answer = createDeferred<unknown>();
    const rpc = vi.fn(() => answer.promise);
    let settled = false;
    const pending = codexAppServerLifecycle.send!(transport(rpc), continuity, input).then((outcome) => {
      settled = true;
      return outcome;
    });
    await flushMicrotasks();
    expect(settled).toBe(false);
    answer.reject(new Error('channel closed'));
    await expect(pending).resolves.toEqual({ state: 'unknown', reason: 'channel closed' });
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it.each([{ cwd: '/workspace' }, { threadId: 'thread-1' }, { turnId: 'turn-1' }])(
    'refuses incomplete continuity before RPC: %j',
    async (partial) => {
      const rpc = vi.fn();
      await expect(codexAppServerLifecycle.send!(transport(rpc), partial, input)).resolves.toMatchObject({
        state: 'refused',
        code: 'turn_not_started',
      });
      expect(rpc).not.toHaveBeenCalled();
    },
  );

  it('rejects malformed continuity as an internal contract violation before RPC', async () => {
    const rpc = vi.fn();
    await expect(codexAppServerLifecycle.send!(transport(rpc), {}, input)).rejects.toThrow(
      new TypeError('Invalid persisted Codex continuity.'),
    );
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([{}, { turnId: '' }, { turnId: 'other-turn' }, null])(
    'reports an invalid acknowledgement as unknown: %j',
    async (response) => {
      const rpc = vi.fn(async () => response);
      await expect(codexAppServerLifecycle.send!(transport(rpc), continuity, input)).resolves.toMatchObject({
        state: 'unknown',
      });
      expect(rpc).toHaveBeenCalledTimes(1);
    },
  );
});
