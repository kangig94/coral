import type * as fs from 'node:fs';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mapThreadResumeParams, mapThreadStartParams, mapTurnStartParams } from '../codex/request-mapping.js';
import type { ProviderRequest } from '../../shared/types.js';

const tempHomes: string[] = [];

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

async function importRequestMappingWithMockedFs(readFileSyncImpl: typeof fs.readFileSync, variant: 'eio' | 'enoent') {
  vi.resetModules();
  vi.doMock('node:fs', async () => {
    const actual = await vi.importActual<typeof fs>('node:fs');
    return {
      ...actual,
      readFileSync: vi.fn(readFileSyncImpl),
    };
  });

  void variant;
  return import('../codex/request-mapping.js');
}

afterEach(() => {
  for (const home of tempHomes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
  vi.doUnmock('node:fs');
  vi.resetModules();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('mapTurnStartParams effort mapping', () => {
  const VALID_CODEX_EFFORT = new Set(['low', 'medium', 'high', 'xhigh']);

  it.each([
    ['low', 'low'],
    ['medium', 'medium'],
    ['high', 'high'],
    ['max', 'xhigh'],
  ] as const)('maps Coral effort %s to Codex %s', (coral, codex) => {
    const params = mapTurnStartParams(makeRequest({ effort: coral }), 'thread-1');
    expect(params.effort).toBe(codex);
  });

  it.each(['low', 'medium', 'high', 'max'] as const)('Coral %s produces a valid Codex effort value', (coral) => {
    const params = mapTurnStartParams(makeRequest({ effort: coral }), 'thread-1');
    expect(VALID_CODEX_EFFORT.has(params.effort as string)).toBe(true);
  });
});

describe('resolveCodexServiceTier precedence', () => {
  it.each([
    ['1', 'fast'],
    ['true', 'fast'],
    ['TRUE', 'fast'],
    ['True', 'fast'],
    ['fast', 'fast'],
    ['0', 'flex'],
    ['false', 'flex'],
    ['FALSE', 'flex'],
    ['flex', 'flex'],
  ] as const)('maps CORAL_CODEX_FAST=%s to %s before config fallback', (envValue, expected) => {
    useTempCodexConfig('service_tier = "flex"');

    const params = mapThreadStartParams(makeRequest({ coralEnv: { CORAL_CODEX_FAST: envValue } }));

    expect(params.serviceTier).toBe(expected);
  });

  it('returns undefined for unrecognized non-empty env values without silently falling through', () => {
    useTempCodexConfig('service_tier = "fast"');

    const params = mapThreadStartParams(makeRequest({ coralEnv: { CORAL_CODEX_FAST: 'garbage' } }));

    expect(params).not.toHaveProperty('serviceTier');
  });

  it('falls through to config when env is empty', () => {
    useTempCodexConfig('service_tier = "fast"');

    const params = mapThreadStartParams(makeRequest({ coralEnv: { CORAL_CODEX_FAST: '' } }));

    expect(params.serviceTier).toBe('fast');
  });

  it('falls through to config when env is whitespace only', () => {
    useTempCodexConfig('service_tier = "fast"');

    const params = mapThreadStartParams(makeRequest({ coralEnv: { CORAL_CODEX_FAST: '   ' } }));

    expect(params.serviceTier).toBe('fast');
  });
});

describe('mapThreadStartParams serviceTier', () => {
  it('includes serviceTier when resolved from env', () => {
    useTempCodexConfig();
    const params = mapThreadStartParams(makeRequest({ coralEnv: { CORAL_CODEX_FAST: '1' } }));

    expect(params.serviceTier).toBe('fast');
  });

  it('omits serviceTier when neither env nor config resolves one', () => {
    useTempCodexConfig();

    const params = mapThreadStartParams(makeRequest());

    expect(params).not.toHaveProperty('serviceTier');
  });
});

describe('mapThreadResumeParams serviceTier', () => {
  it('includes serviceTier when resolved from env', () => {
    useTempCodexConfig();
    const params = mapThreadResumeParams(makeRequest({ coralEnv: { CORAL_CODEX_FAST: '0' } }), 'thread-1');

    expect(params.serviceTier).toBe('flex');
  });

  it('omits serviceTier when neither env nor config resolves one', () => {
    useTempCodexConfig();

    const params = mapThreadResumeParams(makeRequest(), 'thread-1');

    expect(params).not.toHaveProperty('serviceTier');
  });
});

describe('mapTurnStartParams serviceTier', () => {
  it('includes serviceTier when resolved from env', () => {
    useTempCodexConfig();
    const params = mapTurnStartParams(makeRequest({ coralEnv: { CORAL_CODEX_FAST: 'fast' } }), 'thread-1');

    expect(params.serviceTier).toBe('fast');
  });

  it('omits serviceTier when neither env nor config resolves one', () => {
    useTempCodexConfig();

    const params = mapTurnStartParams(makeRequest(), 'thread-1');

    expect(params).not.toHaveProperty('serviceTier');
  });
});

describe('TOML fallback', () => {
  it('reads a top-level fast service_tier', () => {
    useTempCodexConfig('service_tier = "fast"\n[profiles.dev]\nservice_tier = "flex"');

    const params = mapThreadStartParams(makeRequest());

    expect(params.serviceTier).toBe('fast');
  });

  it('reads a top-level flex service_tier', () => {
    useTempCodexConfig("service_tier = 'flex'");

    const params = mapThreadStartParams(makeRequest());

    expect(params.serviceTier).toBe('flex');
  });

  it('reads an unquoted top-level service_tier', () => {
    useTempCodexConfig('service_tier = fast');

    const params = mapThreadStartParams(makeRequest());

    expect(params.serviceTier).toBe('fast');
  });

  it('reads a top-level service_tier with a trailing comment', () => {
    useTempCodexConfig('service_tier = "fast"  # note about priority');

    const params = mapThreadStartParams(makeRequest());

    expect(params.serviceTier).toBe('fast');
  });

  it('ignores profile-scoped service_tier values', () => {
    useTempCodexConfig('[profiles.foo]\nservice_tier = "fast"');

    const params = mapThreadStartParams(makeRequest());

    expect(params).not.toHaveProperty('serviceTier');
  });

  it('swallows missing config file errors', () => {
    useTempCodexConfig();

    const params = mapThreadStartParams(makeRequest());

    expect(params).not.toHaveProperty('serviceTier');
  });

  it('returns undefined for garbled config content', () => {
    useTempCodexConfig('service_tier = maybe-fast');

    const params = mapThreadStartParams(makeRequest());

    expect(params).not.toHaveProperty('serviceTier');
  });

  it('warns on non-ENOENT config read errors and stays silent on ENOENT', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const eioError = Object.assign(new Error('disk I/O failure'), { code: 'EIO' });
    const enoentError = Object.assign(new Error('missing file'), { code: 'ENOENT' });
    const { mapThreadStartParams: mapWithEio } = await importRequestMappingWithMockedFs(() => {
      throw eioError;
    }, 'eio');

    expect(mapWithEio(makeRequest())).not.toHaveProperty('serviceTier');
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('CORAL_CODEX_FAST'));

    stderrSpy.mockClear();
    const { mapThreadStartParams: mapWithEnoent } = await importRequestMappingWithMockedFs(() => {
      throw enoentError;
    }, 'enoent');

    expect(mapWithEnoent(makeRequest())).not.toHaveProperty('serviceTier');
    expect(stderrSpy).not.toHaveBeenCalled();
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
