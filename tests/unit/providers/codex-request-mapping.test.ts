import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  mapThreadResumeParams,
  mapThreadStartParams,
  mapTurnStartParams,
  resolveCodexServiceTier,
} from '#src/providers/codex/request-mapping.js';
import type { ProviderRequest, ProviderRuntime } from '#src/providers/contract.js';

const tempHomes: string[] = [];
type TierReadFileSync = NonNullable<NonNullable<ProviderRuntime['storage']>['readFileSync']>;
type TierStatSync = NonNullable<NonNullable<ProviderRuntime['storage']>['statSync']>;
const defaultReadFileSync: TierReadFileSync = (path, encoding) => readFileSync(path, encoding);
const defaultStatSync: TierStatSync = (path) => statSync(path);

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
): {
  env: { homedir(): string };
  storage: {
    readFileSync: TierReadFileSync;
    statSync: TierStatSync;
    existsSync: (path: string) => boolean;
  };
} {
  return {
    env: { homedir: () => home },
    storage: {
      readFileSync: readFileSyncImpl,
      statSync: statSyncImpl,
      existsSync: () => true,
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

describe('mapTurnStartParams effort mapping', () => {
  const VALID_CODEX_EFFORT = new Set(['low', 'medium', 'high', 'xhigh']);

  it.each([
    ['low', 'low'],
    ['medium', 'medium'],
    ['high', 'high'],
    ['xhigh', 'xhigh'],
    ['max', 'xhigh'],
  ] as const)('maps Coral effort %s to Codex %s', (coral, codex) => {
    const params = mapTurnStartParams(makeRequest({ effort: coral }), 'thread-1');
    expect(params.effort).toBe(codex);
  });

  it.each(['low', 'medium', 'high', 'xhigh', 'max'] as const)('Coral %s produces a valid Codex effort value', (coral) => {
    const params = mapTurnStartParams(makeRequest({ effort: coral }), 'thread-1');
    expect(VALID_CODEX_EFFORT.has(params.effort as string)).toBe(true);
  });

  it('defaults to xhigh when no explicit or env effort is set', () => {
    const params = mapTurnStartParams(makeRequest({ effort: undefined }), 'thread-1');
    expect(params.effort).toBe('xhigh');
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

  it('throws a user-friendly error when CORAL_CODEX_EFFORT is invalid', () => {
    expect(() =>
      mapTurnStartParams(
        makeRequest({ effort: undefined, coralEnv: { CORAL_CODEX_EFFORT: 'turbo' } }),
        'thread-1',
      ),
    ).toThrow('Invalid CORAL_CODEX_EFFORT="turbo". Valid values: low, medium, high, xhigh, max');
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

    expect(mapThreadStartParams(request, resolvedServiceTier(request, home, () => {
      throw eioError;
    }))).not.toHaveProperty('serviceTier');
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('CORAL_CODEX_FAST'));

    stderrSpy.mockClear();
    const missingHome = useTempCodexConfig();
    expect(mapThreadStartParams(request, resolvedServiceTier(request, missingHome, () => {
      throw enoentError;
    }))).not.toHaveProperty('serviceTier');
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('caches service_tier reads when the config mtime is unchanged', () => {
    const home = useTempCodexConfig('service_tier = "fast"');
    const request = makeRequest();
    const configPath = join(home, '.codex', 'config.toml');
    const readSpy = vi.fn<TierReadFileSync>(defaultReadFileSync);
    const statSpy = vi.fn<TierStatSync>(defaultStatSync);

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
    const statSpy = vi.fn<TierStatSync>(defaultStatSync);

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
    const statSpy = vi.fn<TierStatSync>(defaultStatSync);

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

  it('does not leak CORAL_CODEX_MODEL from the daemon process env', () => {
    vi.stubEnv('CORAL_CODEX_MODEL', 'daemon-env-model');

    const request = makeRequest();

    expect(mapThreadStartParams(request).model).toBe('gpt-5.4');
    expect(mapThreadResumeParams(request, 'thread-1').model).toBe('gpt-5.4');
    expect(mapTurnStartParams(request, 'thread-1').model).toBe('gpt-5.4');
  });
});
