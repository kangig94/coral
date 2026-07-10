import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  applyCodexContinuityUpdate,
  buildCodexContinuity,
  buildCodexPrompt,
  buildCodexProviderServerSpec,
  mapThreadResumeParams,
  mapThreadStartParams,
  mapTurnStartParams,
  readCodexPersistedContinuity,
  resolveCodexServiceTier,
  snapshotCodexPersistedContinuity,
} from '#src/providers/codex/request-mapping.js';
import type { ProviderRequest, ProviderRuntime } from '#src/providers/contract.js';
import { backendLog } from '#src/infra/backend-log.js';

const tempHomes: string[] = [];
type TierReadFileSync = NonNullable<NonNullable<ProviderRuntime['storage']>['readFileSync']>;
type TierStatSync = NonNullable<NonNullable<ProviderRuntime['storage']>['statSync']>;
const defaultReadFileSync: TierReadFileSync = (path, encoding) => readFileSync(path, encoding);
const defaultStatSync: TierStatSync = statSync as TierStatSync;

function makeRequest(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    action: 'exec',
    sessionId: 's-1',
    prompt: 'test',
    cwd: '/tmp',
    effort: 'medium',
    bypassPermissions: false,
    coralEnv: {},
    ...overrides,
  };
}

function useTempCodexConfig(content?: string): string {
  const home = mkdtempSync(join(tmpdir(), 'coral-codex-'));
  tempHomes.push(home);
  vi.stubEnv('HOME', home);
  if (content !== undefined) {
    const configDir = join(home, '.codex');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.toml'), content, 'utf-8');
  }
  return home;
}

function makeTierRuntime(
  home: string,
  readFileSyncImpl: TierReadFileSync = defaultReadFileSync,
  statSyncImpl: TierStatSync = defaultStatSync,
): Pick<ProviderRuntime, 'env' | 'storage'> {
  return {
    env: {
      homedir: () => home,
      claudeConfigDir: () => `${home}/.claude`,
      get: () => undefined,
      fullSnapshot: () => ({}),
    },
    storage: {
      readFileSync: readFileSyncImpl,
      statSync: statSyncImpl,
      existsSync: () => true,
      readdirSync: (() => []) as ProviderRuntime['storage']['readdirSync'],
    },
  };
}

function resolvedServiceTier(
  request: ProviderRequest,
  home: string,
  readFileSyncImpl?: TierReadFileSync,
  statSyncImpl?: TierStatSync,
): ReturnType<typeof resolveCodexServiceTier> {
  return resolveCodexServiceTier(
    request,
    makeTierRuntime(home, readFileSyncImpl ?? defaultReadFileSync, statSyncImpl ?? defaultStatSync),
  );
}

afterEach(() => {
  for (const home of tempHomes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('buildCodexPrompt ordering', () => {
  it('orders systemPrompt (INJECT), then instruction, then user prompt', () => {
    const text = buildCodexPrompt(
      makeRequest({
        systemPrompt: 'guidelines',
        instruction: { channel: 'system', content: 'agent body' },
        prompt: 'user task',
      }),
    );
    expect(text).toBe('guidelines\n\n---\n\nagent body\n\n---\n\nuser task');
  });

  it('skips instruction on resume but keeps systemPrompt and prompt', () => {
    const text = buildCodexPrompt(
      makeRequest({
        action: 'resume',
        systemPrompt: 'guidelines',
        instruction: { channel: 'system', content: 'agent body' },
        prompt: 'continue',
      }),
    );
    expect(text).toBe('guidelines\n\n---\n\ncontinue');
    expect(text).not.toContain('agent body');
  });
});

describe('mapTurnStartParams effort mapping', () => {
  const VALID_CODEX_EFFORT = new Set(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

  it.each([
    ['low', 'low'],
    ['medium', 'medium'],
    ['high', 'high'],
    ['xhigh', 'xhigh'],
    ['max', 'max'],
    ['ultra', 'ultra'],
  ] as const)('maps Coral effort %s to Codex %s on GPT-5.6 Sol default', (coral, codex) => {
    // Default model is gpt-5.6-sol — ceiling is ultra.
    const params = mapTurnStartParams(makeRequest({ effort: coral }), 'thread-1');
    expect(params.effort).toBe(codex);
  });

  it.each(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const)(
    'Coral %s produces a valid Codex effort value',
    (coral) => {
      const params = mapTurnStartParams(makeRequest({ effort: coral }), 'thread-1');
      expect(VALID_CODEX_EFFORT.has(params.effort as string)).toBe(true);
    },
  );

  it('caps effort at xhigh on non-GPT-5.6 models (e.g. gpt-5.5)', () => {
    expect(
      mapTurnStartParams(
        makeRequest({ model: 'gpt-5.5', effort: 'max', coralEnv: { CORAL_CODEX_MODEL: 'gpt-5.5' } }),
        'thread-1',
      ).effort,
    ).toBe('xhigh');
    expect(
      mapTurnStartParams(
        makeRequest({
          model: 'sonnet',
          effort: 'ultra',
          coralEnv: { CORAL_CODEX_MODEL: 'gpt-5.5' },
        }),
        'thread-1',
      ).effort,
    ).toBe('xhigh');
  });

  it('allows ultra on Sol and Terra, but caps Luna at max', () => {
    expect(mapTurnStartParams(makeRequest({ model: 'sol', effort: 'ultra' }), 'thread-1').effort).toBe('ultra');
    expect(mapTurnStartParams(makeRequest({ model: 'terra', effort: 'ultra' }), 'thread-1').effort).toBe('ultra');
    expect(mapTurnStartParams(makeRequest({ model: 'gpt-5.6-sol', effort: 'ultra' }), 'thread-1').effort).toBe(
      'ultra',
    );
    expect(mapTurnStartParams(makeRequest({ model: 'gpt-5.6-terra', effort: 'ultra' }), 'thread-1').effort).toBe(
      'ultra',
    );
    expect(mapTurnStartParams(makeRequest({ model: 'luna', effort: 'ultra' }), 'thread-1').effort).toBe('max');
    expect(mapTurnStartParams(makeRequest({ model: 'gpt-5.6-luna', effort: 'ultra' }), 'thread-1').effort).toBe(
      'max',
    );
    expect(mapTurnStartParams(makeRequest({ model: 'haiku', effort: 'ultra' }), 'thread-1').effort).toBe('max');
  });

  it('allows max on all GPT-5.6 family sizes including Luna', () => {
    expect(mapTurnStartParams(makeRequest({ model: 'sol', effort: 'max' }), 'thread-1').effort).toBe('max');
    expect(mapTurnStartParams(makeRequest({ model: 'terra', effort: 'max' }), 'thread-1').effort).toBe('max');
    expect(mapTurnStartParams(makeRequest({ model: 'luna', effort: 'max' }), 'thread-1').effort).toBe('max');
  });

  it('defaults to high when no explicit or env effort is set', () => {
    const params = mapTurnStartParams(makeRequest({ effort: undefined }), 'thread-1');
    expect(params.effort).toBe('high');
  });

  it('falls back to CORAL_CODEX_EFFORT when request effort is unset', () => {
    const params = mapTurnStartParams(
      makeRequest({ effort: undefined, coralEnv: { CORAL_CODEX_EFFORT: 'high' } }),
      'thread-1',
    );
    expect(params.effort).toBe('high');
  });

  it('lets CORAL_CODEX_EFFORT win over CORAL_EFFORT', () => {
    const params = mapTurnStartParams(
      makeRequest({
        effort: undefined,
        coralEnv: { CORAL_CODEX_EFFORT: 'low', CORAL_EFFORT: 'high' },
      }),
      'thread-1',
    );
    expect(params.effort).toBe('low');
  });

  it('falls back to CORAL_EFFORT when no provider-specific effort is set', () => {
    const params = mapTurnStartParams(
      makeRequest({ effort: undefined, coralEnv: { CORAL_EFFORT: 'medium' } }),
      'thread-1',
    );
    expect(params.effort).toBe('medium');
  });

  it('warns and falls back to the default effort when CORAL_CODEX_EFFORT is invalid (no throw)', () => {
    const warnSpy = vi.spyOn(backendLog, 'warn').mockImplementation(() => {});
    const params = mapTurnStartParams(
      makeRequest({ effort: undefined, coralEnv: { CORAL_CODEX_EFFORT: 'turbo' } }),
      'thread-1',
    );
    expect(params.effort).toBe('high'); // CODEX_DEFAULT_EFFORT — not a thrown error
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('CORAL_CODEX_EFFORT="turbo"'));
  });

  it('falls back through CORAL_EFFORT when CORAL_CODEX_EFFORT is invalid', () => {
    vi.spyOn(backendLog, 'warn').mockImplementation(() => {});
    const params = mapTurnStartParams(
      makeRequest({ effort: undefined, coralEnv: { CORAL_CODEX_EFFORT: 'nope', CORAL_EFFORT: 'medium' } }),
      'thread-1',
    );
    expect(params.effort).toBe('medium');
  });

  it('does not raise Sol effort above the configured value', () => {
    expect(mapTurnStartParams(makeRequest({ model: 'opus', effort: 'high' }), 'thread-1').effort).toBe('high');
    expect(mapTurnStartParams(makeRequest({ model: 'sol', effort: 'medium' }), 'thread-1').effort).toBe('medium');
    expect(mapTurnStartParams(makeRequest({ model: 'gpt-5.6-sol', effort: undefined }), 'thread-1').effort).toBe(
      'high',
    );
  });

  it.each([
    ['sonnet', 'gpt-5.6-terra'],
    ['haiku', 'gpt-5.6-luna'],
    ['terra', 'gpt-5.6-terra'],
    ['luna', 'gpt-5.6-luna'],
    ['gpt-5.6-terra', 'gpt-5.6-terra'],
    ['gpt-5.6-luna', 'gpt-5.6-luna'],
  ] as const)('floors %s effort to xhigh (resolved model %s)', (model, resolvedModel) => {
    const params = mapTurnStartParams(makeRequest({ model, effort: 'high' }), 'thread-1');
    expect(params.model).toBe(resolvedModel);
    expect(params.effort).toBe('xhigh');
  });

  it('floors terra/luna below xhigh even when CORAL_CODEX_EFFORT is low', () => {
    const params = mapTurnStartParams(
      makeRequest({
        model: 'sonnet',
        effort: undefined,
        coralEnv: { CORAL_CODEX_EFFORT: 'low' },
      }),
      'thread-1',
    );
    expect(params.model).toBe('gpt-5.6-terra');
    expect(params.effort).toBe('xhigh');
  });

  it('keeps terra/luna at or above the xhigh floor without over-clipping', () => {
    expect(mapTurnStartParams(makeRequest({ model: 'luna', effort: 'xhigh' }), 'thread-1').effort).toBe('xhigh');
    expect(mapTurnStartParams(makeRequest({ model: 'terra', effort: 'max' }), 'thread-1').effort).toBe('max');
    expect(mapTurnStartParams(makeRequest({ model: 'terra', effort: 'ultra' }), 'thread-1').effort).toBe('ultra');
  });

  it('does not apply terra/luna floor on non-GPT-5.6 baselines', () => {
    // Abstract tiers collapse to gpt-5.5 — no terra/luna identity, so no floor.
    const params = mapTurnStartParams(
      makeRequest({
        model: 'sonnet',
        effort: 'high',
        coralEnv: { CORAL_CODEX_MODEL: 'gpt-5.5' },
      }),
      'thread-1',
    );
    expect(params.model).toBe('gpt-5.5');
    expect(params.effort).toBe('high');
  });
});

describe('Codex continuity refs', () => {
  it('drops unexpected persisted keys and does not trust unscoped cwd', () => {
    const continuity = readCodexPersistedContinuity(
      {
        cwd: '/workspace/project',
        threadId: 'thread-1',
        turnId: 'turn-1',
        attacker: 'keep-out',
      },
      { allowUnscopedCwd: false },
    );

    expect(continuity).toEqual({
      cwd: undefined,
      threadId: 'thread-1',
      turnId: 'turn-1',
    });
    expect(continuity).not.toHaveProperty('attacker');
  });

  it('drops empty persisted ids and never treats them as resumable', () => {
    const continuity = readCodexPersistedContinuity({
      cwd: '',
      threadId: '',
      turnId: '',
    });

    expect(continuity).toEqual({
      cwd: undefined,
      threadId: undefined,
      turnId: undefined,
    });
    expect(snapshotCodexPersistedContinuity(continuity)).toEqual({
      conversationRef: null,
      resumable: false,
      providerContinuity: null,
    });
  });

  it('uses explicit non-empty refs for updates while ignoring empty conversationRef', () => {
    const persisted = buildCodexContinuity({
      cwd: '/workspace',
      threadId: 'thread-1',
      turnId: 'turn-1',
    });

    expect(applyCodexContinuityUpdate(persisted, { conversationRef: '' })).toEqual(persisted);
    expect(applyCodexContinuityUpdate(persisted, { conversationRef: 'thread-2' })).toEqual({
      cwd: '/workspace',
      threadId: 'thread-2',
      turnId: 'turn-1',
    });
    expect(applyCodexContinuityUpdate(persisted, { conversationRef: null })).toEqual({});
  });

  it('uses an in-scope persisted cwd for the Codex app-server cwd', () => {
    const continuity = {
      cwd: '/workspace/project/subdir',
      threadId: 'thread-1',
      attacker: 'keep-out',
    };

    const spec = buildCodexProviderServerSpec({ cwd: '/workspace/project', coralEnv: {} }, continuity);

    expect(spec.cwd).toBe('/workspace/project/subdir');
    expect(readCodexPersistedContinuity(continuity)).toEqual({
      cwd: '/workspace/project/subdir',
      threadId: 'thread-1',
      turnId: undefined,
    });
  });

  it('ignores a persisted cwd outside the current project scope', () => {
    const continuity = {
      cwd: '/tmp/attacker',
      threadId: 'thread-1',
    };

    const spec = buildCodexProviderServerSpec({ cwd: '/workspace/project', coralEnv: {} }, continuity);

    expect(spec.cwd).toBe('/workspace/project');
    expect(readCodexPersistedContinuity(continuity)).toEqual({
      cwd: undefined,
      threadId: 'thread-1',
      turnId: undefined,
    });
  });
});

describe('resolveCodexServiceTier precedence', () => {
  it.each([
    ['1', 'fast'],
    ['0', 'flex'],
  ] as const)('maps CORAL_CODEX_FAST=%s to %s before config fallback', (envValue, expected) => {
    const home = useTempCodexConfig('service_tier = "flex"');
    const request = makeRequest({ coralEnv: { CORAL_CODEX_FAST: envValue } });

    const params = mapThreadStartParams(request, resolvedServiceTier(request, home));

    expect(params.serviceTier).toBe(expected);
  });

  it('returns undefined for unrecognized non-empty env values without silently falling through', () => {
    const home = useTempCodexConfig('service_tier = "fast"');
    const request = makeRequest({ coralEnv: { CORAL_CODEX_FAST: 'garbage' } });

    const params = mapThreadStartParams(request, resolvedServiceTier(request, home));

    expect(params).not.toHaveProperty('serviceTier');
  });

  it('falls through to config when env is empty', () => {
    const home = useTempCodexConfig('service_tier = "fast"');
    const request = makeRequest({ coralEnv: { CORAL_CODEX_FAST: '' } });

    const params = mapThreadStartParams(request, resolvedServiceTier(request, home));

    expect(params.serviceTier).toBe('fast');
  });

  it('falls through to config when env is whitespace only', () => {
    const home = useTempCodexConfig('service_tier = "fast"');
    const request = makeRequest({ coralEnv: { CORAL_CODEX_FAST: '   ' } });

    const params = mapThreadStartParams(request, resolvedServiceTier(request, home));

    expect(params.serviceTier).toBe('fast');
  });
});

describe('mapThreadStartParams serviceTier', () => {
  it('includes serviceTier when resolved from env', () => {
    const home = useTempCodexConfig();
    const request = makeRequest({ coralEnv: { CORAL_CODEX_FAST: '1' } });
    const params = mapThreadStartParams(request, resolvedServiceTier(request, home));

    expect(params.serviceTier).toBe('fast');
  });

  it('omits serviceTier when neither env nor config resolves one', () => {
    const home = useTempCodexConfig();
    const request = makeRequest();

    const params = mapThreadStartParams(request, resolvedServiceTier(request, home));

    expect(params).not.toHaveProperty('serviceTier');
  });
});

describe('mapThreadResumeParams serviceTier', () => {
  it('includes serviceTier when resolved from env', () => {
    const home = useTempCodexConfig();
    const request = makeRequest({ coralEnv: { CORAL_CODEX_FAST: '0' } });
    const params = mapThreadResumeParams(request, 'thread-1', resolvedServiceTier(request, home));

    expect(params.serviceTier).toBe('flex');
  });

  it('omits serviceTier when neither env nor config resolves one', () => {
    const home = useTempCodexConfig();
    const request = makeRequest();

    const params = mapThreadResumeParams(request, 'thread-1', resolvedServiceTier(request, home));

    expect(params).not.toHaveProperty('serviceTier');
  });
});

describe('mapTurnStartParams serviceTier', () => {
  it('includes serviceTier when resolved from env', () => {
    const home = useTempCodexConfig();
    const request = makeRequest({ coralEnv: { CORAL_CODEX_FAST: '1' } });
    const params = mapTurnStartParams(request, 'thread-1', resolvedServiceTier(request, home));

    expect(params.serviceTier).toBe('fast');
  });

  it('omits serviceTier when neither env nor config resolves one', () => {
    const home = useTempCodexConfig();
    const request = makeRequest();

    const params = mapTurnStartParams(request, 'thread-1', resolvedServiceTier(request, home));

    expect(params).not.toHaveProperty('serviceTier');
  });
});

describe('TOML fallback', () => {
  it('reads a top-level fast service_tier', () => {
    const home = useTempCodexConfig('service_tier = "fast"\n[profiles.dev]\nservice_tier = "flex"');
    const request = makeRequest();

    const params = mapThreadStartParams(request, resolvedServiceTier(request, home));

    expect(params.serviceTier).toBe('fast');
  });

  it('reads a top-level flex service_tier', () => {
    const home = useTempCodexConfig("service_tier = 'flex'");
    const request = makeRequest();

    const params = mapThreadStartParams(request, resolvedServiceTier(request, home));

    expect(params.serviceTier).toBe('flex');
  });

  it('reads an unquoted top-level service_tier', () => {
    const home = useTempCodexConfig('service_tier = fast');
    const request = makeRequest();

    const params = mapThreadStartParams(request, resolvedServiceTier(request, home));

    expect(params.serviceTier).toBe('fast');
  });

  it('reads a top-level service_tier with a trailing comment', () => {
    const home = useTempCodexConfig('service_tier = "fast"  # note about priority');
    const request = makeRequest();

    const params = mapThreadStartParams(request, resolvedServiceTier(request, home));

    expect(params.serviceTier).toBe('fast');
  });

  it('ignores profile-scoped service_tier values', () => {
    const home = useTempCodexConfig('[profiles.foo]\nservice_tier = "fast"');
    const request = makeRequest();

    const params = mapThreadStartParams(request, resolvedServiceTier(request, home));

    expect(params).not.toHaveProperty('serviceTier');
  });

  it('swallows missing config file errors', () => {
    const home = useTempCodexConfig();
    const request = makeRequest();

    const params = mapThreadStartParams(request, resolvedServiceTier(request, home));

    expect(params).not.toHaveProperty('serviceTier');
  });

  it('returns undefined for garbled config content', () => {
    const home = useTempCodexConfig('service_tier = maybe-fast');
    const request = makeRequest();

    const params = mapThreadStartParams(request, resolvedServiceTier(request, home));

    expect(params).not.toHaveProperty('serviceTier');
  });

  it('warns on non-ENOENT config read errors and stays silent on ENOENT', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const eioError = Object.assign(new Error('disk I/O failure'), { code: 'EIO' });
    const enoentError = Object.assign(new Error('missing file'), { code: 'ENOENT' });
    const home = useTempCodexConfig('service_tier = "fast"');
    const request = makeRequest();

    expect(
      mapThreadStartParams(
        request,
        resolvedServiceTier(request, home, () => {
          throw eioError;
        }),
      ),
    ).not.toHaveProperty('serviceTier');
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('CORAL_CODEX_FAST'));

    stderrSpy.mockClear();
    const missingHome = useTempCodexConfig();
    expect(
      mapThreadStartParams(
        request,
        resolvedServiceTier(request, missingHome, () => {
          throw enoentError;
        }),
      ),
    ).not.toHaveProperty('serviceTier');
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('caches service_tier reads when the config mtime is unchanged', () => {
    const home = useTempCodexConfig('service_tier = "fast"');
    const request = makeRequest();
    const configPath = join(home, '.codex', 'config.toml');
    const readSpy = vi.fn<TierReadFileSync>(defaultReadFileSync);
    const statSpy: TierStatSync = vi.fn(defaultStatSync) as unknown as TierStatSync;

    expect(resolvedServiceTier(request, home, readSpy, statSpy)).toBe('fast');
    expect(resolvedServiceTier(request, home, readSpy, statSpy)).toBe('fast');
    expect(statSpy).toHaveBeenCalledTimes(2);
    expect(readSpy).toHaveBeenCalledTimes(1);
    expect(readSpy).toHaveBeenCalledWith(configPath, 'utf-8');
  });

  it('re-reads the config when the mtime changes', () => {
    const home = useTempCodexConfig('service_tier = "fast"');
    const request = makeRequest();
    const configPath = join(home, '.codex', 'config.toml');
    const readSpy = vi.fn<TierReadFileSync>(defaultReadFileSync);
    const statSpy: TierStatSync = vi.fn(defaultStatSync) as unknown as TierStatSync;

    expect(resolvedServiceTier(request, home, readSpy, statSpy)).toBe('fast');

    const updatedAt = new Date(statSync(configPath).mtimeMs + 1_000);
    writeFileSync(configPath, 'service_tier = "flex"', 'utf-8');
    utimesSync(configPath, updatedAt, updatedAt);

    expect(resolvedServiceTier(request, home, readSpy, statSpy)).toBe('flex');
    expect(statSpy).toHaveBeenCalledTimes(2);
    expect(readSpy).toHaveBeenCalledTimes(2);
  });

  it('caches missing top-level service_tier results when the config mtime is unchanged', () => {
    const home = useTempCodexConfig('[profiles.dev]\nservice_tier = "fast"');
    const request = makeRequest();
    const readSpy = vi.fn<TierReadFileSync>(defaultReadFileSync);
    const statSpy: TierStatSync = vi.fn(defaultStatSync) as unknown as TierStatSync;

    expect(resolvedServiceTier(request, home, readSpy, statSpy)).toBeUndefined();
    expect(resolvedServiceTier(request, home, readSpy, statSpy)).toBeUndefined();
    expect(statSpy).toHaveBeenCalledTimes(2);
    expect(readSpy).toHaveBeenCalledTimes(1);
  });
});

describe('resolveCodexModel uses coralEnv', () => {
  it('uses CORAL_CODEX_MODEL from request.coralEnv across all mapping functions', () => {
    const request = makeRequest({ coralEnv: { CORAL_CODEX_MODEL: 'custom-model' } });

    expect(mapThreadStartParams(request).model).toBe('custom-model');
    expect(mapThreadResumeParams(request, 'thread-1').model).toBe('custom-model');
    expect(mapTurnStartParams(request, 'thread-1').model).toBe('custom-model');
  });

  it.each([
    ['sol', 'gpt-5.6-sol'],
    ['terra', 'gpt-5.6-terra'],
    ['luna', 'gpt-5.6-luna'],
  ] as const)('normalizes bare GPT-5.6 baseline alias %s to %s', (alias, codexModel) => {
    const request = makeRequest({ model: undefined, coralEnv: { CORAL_CODEX_MODEL: alias } });

    expect(mapThreadStartParams(request).model).toBe(codexModel);
  });

  it('preserves a non-alias CORAL_CODEX_MODEL baseline', () => {
    const request = makeRequest({ model: undefined, coralEnv: { CORAL_CODEX_MODEL: 'gpt-5.5' } });

    expect(mapThreadStartParams(request).model).toBe('gpt-5.5');
  });

  it('does not leak CORAL_CODEX_MODEL from the daemon process env', () => {
    vi.stubEnv('CORAL_CODEX_MODEL', 'daemon-env-model');

    const request = makeRequest();

    expect(mapThreadStartParams(request).model).toBe('gpt-5.6-sol');
    expect(mapThreadResumeParams(request, 'thread-1').model).toBe('gpt-5.6-sol');
    expect(mapTurnStartParams(request, 'thread-1').model).toBe('gpt-5.6-sol');
  });

  it.each([
    ['opus', 'gpt-5.6-sol'],
    ['sonnet', 'gpt-5.6-terra'],
    ['haiku', 'gpt-5.6-luna'],
  ] as const)('maps abstract tier %s to Codex model %s under GPT-5.6 default', (tier, codexModel) => {
    const request = makeRequest({ model: tier });

    expect(mapThreadStartParams(request).model).toBe(codexModel);
    expect(mapThreadResumeParams(request, 'thread-1').model).toBe(codexModel);
    expect(mapTurnStartParams(request, 'thread-1').model).toBe(codexModel);
  });

  it.each([
    ['opus', 'gpt-5.6-sol'],
    ['sonnet', 'gpt-5.6-terra'],
    ['haiku', 'gpt-5.6-luna'],
  ] as const)('maps abstract tier %s when CORAL_CODEX_MODEL is GPT-5.6 family', (tier, codexModel) => {
    const request = makeRequest({
      model: tier,
      coralEnv: { CORAL_CODEX_MODEL: 'gpt-5.6-sol' },
    });

    expect(mapThreadStartParams(request).model).toBe(codexModel);
    expect(mapTurnStartParams(request, 'thread-1').model).toBe(codexModel);
  });

  it('maps abstract tiers when CORAL_CODEX_MODEL is a bare GPT-5.6 alias', () => {
    const request = makeRequest({
      model: 'sonnet',
      coralEnv: { CORAL_CODEX_MODEL: 'gpt-5.6-sol' },
    });

    expect(mapThreadStartParams(request).model).toBe('gpt-5.6-terra');
  });

  it.each([
    ['sol', 'gpt-5.6-sol'],
    ['terra', 'gpt-5.6-terra'],
    ['luna', 'gpt-5.6-luna'],
  ] as const)('normalizes bare GPT-5.6 size alias %s to %s', (alias, codexModel) => {
    const request = makeRequest({ model: alias });

    expect(mapThreadStartParams(request).model).toBe(codexModel);
    expect(mapThreadResumeParams(request, 'thread-1').model).toBe(codexModel);
    expect(mapTurnStartParams(request, 'thread-1').model).toBe(codexModel);
  });

  it('normalizes a bare size alias even under a non-GPT-5.6 CORAL_CODEX_MODEL (explicit concrete size)', () => {
    const request = makeRequest({ model: 'terra', coralEnv: { CORAL_CODEX_MODEL: 'gpt-5.5' } });

    expect(mapThreadStartParams(request).model).toBe('gpt-5.6-terra');
  });

  it('collapses abstract tiers to a non-GPT-5.6 CORAL_CODEX_MODEL (no sol/terra/luna split)', () => {
    const request = makeRequest({
      model: 'opus',
      coralEnv: { CORAL_CODEX_MODEL: 'gpt-5.5' },
    });

    expect(mapThreadStartParams(request).model).toBe('gpt-5.5');
    expect(mapThreadResumeParams(request, 'thread-1').model).toBe('gpt-5.5');
    expect(mapTurnStartParams(request, 'thread-1').model).toBe('gpt-5.5');
  });

  it.each(['opus', 'sonnet', 'haiku'] as const)(
    'uses the same non-GPT-5.6 baseline for abstract tier %s',
    (tier) => {
      const request = makeRequest({
        model: tier,
        coralEnv: { CORAL_CODEX_MODEL: 'gpt-5.5' },
      });
      expect(mapTurnStartParams(request, 'thread-1').model).toBe('gpt-5.5');
    },
  );

  it('passes concrete model ids through unchanged', () => {
    const request = makeRequest({ model: 'gpt-5.6-sol' });

    expect(mapThreadStartParams(request).model).toBe('gpt-5.6-sol');
    expect(mapTurnStartParams(request, 'thread-1').model).toBe('gpt-5.6-sol');
  });

  it('passes concrete model ids even when CORAL_CODEX_MODEL is a different line', () => {
    const request = makeRequest({
      model: 'gpt-5.4',
      coralEnv: { CORAL_CODEX_MODEL: 'gpt-5.5' },
    });

    expect(mapThreadStartParams(request).model).toBe('gpt-5.4');
  });
});
