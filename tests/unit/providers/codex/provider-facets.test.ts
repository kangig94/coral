import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TEST_CODEX_ACCESS } from '../../../helpers/provider-credentials.js';
import { codexPreflight, codexRecoveryLifecycle } from '#src/providers/codex/provider-facets.js';
import { buildCodexContinuity } from '#src/providers/codex/request-mapping.js';
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
