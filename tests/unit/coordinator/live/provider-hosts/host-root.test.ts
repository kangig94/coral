import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { localProviderHostRoot } from '#src/infra/bundle-manifest.js';
import { providerProxyPlacement } from '#src/coordinator/live/provider-hosts/host-root.js';
import { claudeAppServerLifecycle } from '#src/providers/claude/provider-facets.js';
import { codexAppServerLifecycle } from '#src/providers/codex/provider-facets.js';

import { hostFingerprintFromSpec } from '#src/providers/host-identity.js';
import { TEST_CLAUDE_ACCESS, TEST_CODEX_ACCESS } from '#tests/helpers/provider-credentials.js';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';

afterEach(() => vi.unstubAllGlobals());

const input = {
  purpose: 'execution' as const,
  request: {
    action: 'exec' as const,
    sessionId: 'session',
    prompt: 'hello',
    cwd: fixtureCanonicalWorkDir('/workspace'),
    bypassPermissions: false,
    coralEnv: {},
  },
  baseEnv: { PATH: '/bin' },
  platform: 'linux',
  storage: { existsSync: () => true },
};

describe('provider host root ownership', () => {
  it('compiles byte-identical Claude specs and fingerprints from the installed running root', () => {
    const config = { pluginRoot: '/plugin/cache' };
    vi.stubGlobal('__PLUGIN_ROOT__', config.pluginRoot);
    vi.stubGlobal('__BUNDLE_DIR__', '/plugin/cache/bridge');
    const coordinator = claudeAppServerLifecycle.compileStableHost(
      claudeAppServerLifecycle.planHost({
        ...input,
        access: TEST_CLAUDE_ACCESS,
        hostRoot: providerProxyPlacement().hostRoot,
      }),
    );
    vi.stubGlobal('__BUNDLE_DIR__', '/plugin/cache/bridge');
    const proxy = claudeAppServerLifecycle.compileStableHost(
      claudeAppServerLifecycle.planHost({
        ...input,
        access: TEST_CLAUDE_ACCESS,
        hostRoot: localProviderHostRoot(),
      }),
    );
    expect(JSON.stringify(coordinator)).toBe(JSON.stringify(proxy));
    expect(coordinator.args).toEqual(['/plugin/cache/bridge/coral-claude-appserver.cjs']);
    expect(hostFingerprintFromSpec(coordinator)).toBe(hostFingerprintFromSpec(proxy));
  });

  it('uses the coordinator running bundle for proxy placement', () => {
    vi.stubGlobal('__PLUGIN_ROOT__', '/installed');
    vi.stubGlobal('__BUNDLE_DIR__', '/running/bridge');
    expect(localProviderHostRoot()).toBe('/running/bridge');
    expect(providerProxyPlacement().hostRoot).toBe('/running/bridge');
  });

  it('keeps the external Codex executable identity independent of either bundle root', () => {
    const compile = (hostRoot: string) =>
      codexAppServerLifecycle.compileStableHost(
        codexAppServerLifecycle.planHost({ ...input, access: TEST_CODEX_ACCESS, hostRoot }),
      );
    expect(compile('/plugin/cache')).toEqual(compile('/retained/build'));
    expect(compile('/retained/build')).toMatchObject({ command: 'codex', args: ['app-server'] });
  });
});

it('uses the actual local bundle directory when it is a development build rather than bridge', () => {
  vi.stubGlobal('__PLUGIN_ROOT__', '/installed');
  vi.stubGlobal('__BUNDLE_DIR__', '/development/clients/build');
  const spec = claudeAppServerLifecycle.compileStableHost(
    claudeAppServerLifecycle.planHost({
      ...input,
      access: TEST_CLAUDE_ACCESS,
      hostRoot: providerProxyPlacement().hostRoot,
    }),
  );
  expect(providerProxyPlacement().entrypoint).toBeNull();
  expect(spec.args).toEqual(['/development/clients/build/coral-claude-appserver.cjs']);
});

it('keeps one running placement after ambient bundle changes', () => {
  vi.stubGlobal('__PLUGIN_ROOT__', '/installed');
  vi.stubGlobal('__BUNDLE_DIR__', '/coordinator/build');
  const placement = providerProxyPlacement();
  vi.stubGlobal('__BUNDLE_DIR__', '/later/bundle');
  expect(placement).toEqual({
    hostRoot: '/coordinator/build',
    entrypoint: null,
  });
  expect(providerProxyPlacement()).toEqual({ hostRoot: '/later/bundle', entrypoint: null });
});
it('guards an unbuilt source run and supports compiled dist output', () => {
  vi.stubGlobal('__PLUGIN_ROOT__', undefined);
  vi.stubGlobal('__BUNDLE_DIR__', undefined);
  expect(localProviderHostRoot).toThrow('requires __PLUGIN_ROOT__');
  const root = mkdtempSync(join(tmpdir(), 'coral-source-root-'));
  try {
    const appserver = join(root, 'dist', 'providers', 'claude', 'appserver');
    mkdirSync(appserver, { recursive: true });
    writeFileSync(join(appserver, 'server.js'), '');
    vi.stubGlobal('__PLUGIN_ROOT__', root);
    const spec = claudeAppServerLifecycle.compileStableHost(
      claudeAppServerLifecycle.planHost({ ...input, access: TEST_CLAUDE_ACCESS, hostRoot: localProviderHostRoot() }),
    );
    expect(spec.args).toEqual([join(appserver, 'server.js')]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
