import { join } from 'node:path';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';
import {
  CODEX_CAPACITY_CONTINUATION_PROMPT,
  CODEX_CYBER_POLICY_CONTINUATION_PROMPT,
  mapThreadResumeParams,
  mapThreadStartParams,
  mapRecoveryContinuationTurnStartParams,
  mapTurnStartParams,
  readCodexPersistedContinuity,
  resolveCodexServiceTier,
  resolveCodexSelection,
  type CodexServiceTier,
} from '#src/providers/codex/request-mapping.js';
import { prepareTestCodexAppServer } from '#tests/helpers/provider-credentials.js';
import type { ProviderRequest, ProviderRuntime } from '#src/providers/contract.js';
import {
  buildCodexExecutionPlan,
  buildCodexHost,
  type CodexExecutionPlan,
} from '#src/providers/codex/execution-plan.js';
import type { CodexModelCatalog } from '#src/providers/codex/model-catalog.js';

const configs = new Map<string, string>();
let nextAccount = 0;
type CodexRuntime = ProviderRuntime<CodexExecutionPlan>;
type TierReadFileSync = NonNullable<NonNullable<CodexRuntime['storage']>['readFileSync']>;
type TierStatSync = NonNullable<NonNullable<CodexRuntime['storage']>['statSync']>;
const defaultReadFileSync: TierReadFileSync = (path) => {
  const content = configs.get(String(path));
  if (content === undefined) throw Object.assign(new Error('missing config'), { code: 'ENOENT' });
  return content;
};
const defaultStatSync: TierStatSync = (() => ({ mtimeMs: 1 })) as unknown as TierStatSync;

describe('mapRecoveryContinuationTurnStartParams', () => {
  it.each([
    ['serverOverloaded', CODEX_CAPACITY_CONTINUATION_PROMPT],
    ['cyberPolicy', CODEX_CYBER_POLICY_CONTINUATION_PROMPT],
  ] as const)('preserves resolved wire settings and replaces only the input for %s', (failure, expectedPrompt) => {
    const original = turnStartParams(
      makeRequest({
        prompt: 'original task',
        systemPrompt: 'system rules',
        model: 'terra',
        effort: 'max',
      }),
      'thread-1',
      'fast',
    );

    const continuation = mapRecoveryContinuationTurnStartParams(original, failure);

    expect(continuation).toEqual({
      ...original,
      input: [{ type: 'text', text: expectedPrompt, text_elements: [] }],
    });
    expect(continuation.input[0]?.text).not.toContain('original task');
    expect(continuation.input[0]?.text).not.toContain('system rules');
  });
});

function makeRequest(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    action: 'exec',
    sessionId: 's-1',
    prompt: 'test',
    cwd: fixtureCanonicalWorkDir('/tmp'),
    effort: 'medium',
    bypassPermissions: false,
    coralEnv: {},
    ...overrides,
  };
}

const unavailableCatalog: CodexModelCatalog = { kind: 'unavailable', reason: 'Catalog unavailable in fixture' };

function threadStartParams(
  request: ProviderRequest,
  config: Readonly<Record<string, unknown>>,
  tier?: CodexServiceTier,
) {
  return mapThreadStartParams(request, resolveCodexSelection(request, unavailableCatalog), config, tier);
}

function threadResumeParams(
  request: ProviderRequest,
  threadId: string,
  config: Readonly<Record<string, unknown>>,
  tier?: CodexServiceTier,
) {
  return mapThreadResumeParams(request, resolveCodexSelection(request, unavailableCatalog), threadId, config, tier);
}

function turnStartParams(request: ProviderRequest, threadId: string, tier?: CodexServiceTier) {
  return mapTurnStartParams(request, resolveCodexSelection(request, unavailableCatalog), threadId, tier);
}

function useCodexConfig(content: string): string {
  const home = '/accounts/account-' + nextAccount++;
  configs.set(join(home, '.codex', 'config.toml'), content);
  return home;
}

function makeTierRuntime(
  home: string,
  readFileSyncImpl: TierReadFileSync = defaultReadFileSync,
  statSyncImpl: TierStatSync = defaultStatSync,
  codexHome = join(home, '.codex'),
): Pick<CodexRuntime, 'executionPlan' | 'storage'> {
  const host = buildCodexHost({
    access: { home: codexHome },
    request: {
      action: 'exec',
      sessionId: 'tier-test',
      prompt: 'test',
      cwd: fixtureCanonicalWorkDir('/workspace'),
      bypassPermissions: false,
      coralEnv: {},
    },
    baseEnv: {},
    platform: 'linux',
  });
  const prepared = buildCodexExecutionPlan({
    access: { home: codexHome },
    hostPlan: host,
    request: {
      action: 'exec',
      sessionId: 'tier-test',
      prompt: 'test',
      cwd: fixtureCanonicalWorkDir('/workspace'),
      bypassPermissions: false,
      coralEnv: {},
    },
    baseEnv: {},
    platform: 'linux',
  });
  return {
    executionPlan: { host, session: prepared.session, turn: prepared.turn },
    storage: {
      readFileSync: readFileSyncImpl,
      statSync: statSyncImpl,
      existsSync: () => true,
      readdirSync: (() => []) as CodexRuntime['storage']['readdirSync'],
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
  configs.clear();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('mapTurnStartParams effort mapping', () => {
  it('caps effort at xhigh on single-size models (e.g. gpt-5.5)', () => {
    expect(
      turnStartParams(
        makeRequest({ model: 'gpt-5.5', effort: 'max', coralEnv: { CORAL_CODEX_MODEL: 'gpt-5.5' } }),
        'thread-1',
      ).effort,
    ).toBe('xhigh');
    expect(
      turnStartParams(
        makeRequest({
          model: 'sonnet',
          effort: 'ultra',
          coralEnv: { CORAL_CODEX_MODEL: 'gpt-5.5' },
        }),
        'thread-1',
      ).effort,
    ).toBe('xhigh');
  });

  it.each([['sonnet', 'gpt-5.6-terra']] as const)(
    'floors %s effort to xhigh (resolved model %s)',
    (model, resolvedModel) => {
      const params = turnStartParams(makeRequest({ model, effort: 'high' }), 'thread-1');
      expect(params.model).toBe(resolvedModel);
      expect(params.effort).toBe('xhigh');
    },
  );
});

describe('Codex continuity refs', () => {
  it('ignores a persisted cwd outside the current project scope', () => {
    const project = fixtureCanonicalWorkDir('/workspace/project');
    const continuity = {
      cwd: '/tmp/attacker',
      threadId: 'thread-1',
    };

    const spec = prepareTestCodexAppServer({ cwd: project }, continuity);

    expect(spec.cwd).toBe(project);
    expect(readCodexPersistedContinuity(continuity)).toEqual({
      cwd: '/tmp/attacker',
      threadId: 'thread-1',
      turnId: undefined,
    });
  });
});

describe('resolveCodexServiceTier precedence', () => {
  it.each([['1', 'fast']] as const)('maps CORAL_CODEX_FAST=%s to %s before config fallback', (envValue, expected) => {
    const home = useCodexConfig('service_tier = "flex"');
    const request = makeRequest({ coralEnv: { CORAL_CODEX_FAST: envValue } });

    const params = threadStartParams(request, {}, resolvedServiceTier(request, home));

    expect(params.serviceTier).toBe(expected);
  });
});

describe('TOML fallback', () => {
  it('reads service_tier from the selected account instead of the daemon user home', () => {
    const daemonHome = useCodexConfig('service_tier = "default"');
    const selectedHome = useCodexConfig('service_tier = "fast"');
    const request = makeRequest();

    expect(
      resolveCodexServiceTier(
        request,
        makeTierRuntime(daemonHome, defaultReadFileSync, defaultStatSync, join(selectedHome, '.codex')),
      ),
    ).toBe('fast');
  });

  it('reads a top-level flex service_tier', () => {
    const home = useCodexConfig("service_tier = 'flex'");
    const request = makeRequest();

    const params = threadStartParams(request, {}, resolvedServiceTier(request, home));

    expect(params.serviceTier).toBe('flex');
  });

  it('sends fast-off as explicit default across all requests so a live app-server cannot retain fast', () => {
    const home = useCodexConfig('service_tier = "default"');
    const request = makeRequest();
    const serviceTier = resolvedServiceTier(request, home);

    expect(threadStartParams(request, {}, serviceTier).serviceTier).toBe('default');
    expect(threadResumeParams(request, 'thread-1', {}, serviceTier).serviceTier).toBe('default');
    expect(turnStartParams(request, 'thread-1', serviceTier).serviceTier).toBe('default');
  });
});

describe('resolveCodexSelection uses coralEnv', () => {
  it('does not leak CORAL_CODEX_MODEL from the daemon process env', () => {
    vi.stubEnv('CORAL_CODEX_MODEL', 'daemon-env-model');

    const request = makeRequest();

    expect(threadStartParams(request, {}).model).toBe('gpt-6-sol');
    expect(threadResumeParams(request, 'thread-1', {}).model).toBe('gpt-6-sol');
    expect(turnStartParams(request, 'thread-1').model).toBe('gpt-6-sol');
  });
});

describe('catalog model resolution', () => {
  const catalog: CodexModelCatalog = {
    kind: 'listed',
    skippedEntries: 0,
    newestBySize: { sol: 'gpt-6.1-sol', astra: 'gpt-6-astra', terra: 'gpt-5.6-terra', luna: 'gpt-6-luna' },
    supportedEfforts: new Map([['gpt-6.1-sol', ['high', 'max']]]),
  };

  it('shares the resolved selection across thread creation, resume, and turn parameters', () => {
    const request = makeRequest({ model: 'opus', effort: 'ultra' });
    const selection = resolveCodexSelection(request, catalog);

    expect(mapThreadStartParams(request, selection, {}).model).toBe(selection.model);
    expect(mapThreadResumeParams(request, selection, 'thread-1', {}).model).toBe(selection.model);
    expect(mapTurnStartParams(request, selection, 'thread-1')).toMatchObject({
      model: selection.model,
      effort: selection.effort,
    });
  });
});
