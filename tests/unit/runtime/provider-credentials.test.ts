import { describe, expect, it } from 'vitest';

import {
  ambientClaudeLocation,
  canonicalizeProviderCredentialSet,
  captureProviderCredentialSetInput,
  filesystemProviderCredentialSourceAvailability,
  projectProviderCredentialSource,
  providerCredentialSourceKey,
  providerRoutingEnv,
  sameProviderCredentialSource,
} from '#src/runtime/provider-credentials.js';
import { buildExactProviderEnv } from '#src/providers/execution-context.js';

describe('provider credential sources', () => {
  it('captures explicit account selectors without consulting provider state', () => {
    expect(
      captureProviderCredentialSetInput(
        { CODEX_HOME: '/accounts/codex-a', CLAUDE_CONFIG_DIR: '/accounts/claude-a' },
        '/home/operator',
      ),
    ).toEqual({
      version: 1,
      codex: { kind: 'home', home: '/accounts/codex-a' },
      claude: { kind: 'config-dir', configDir: '/accounts/claude-a' },
    });
  });

  it('canonicalizes paths and resolves ambient Claude authority once at the boundary', () => {
    const explicit = canonicalizeProviderCredentialSet(
      {
        version: 1,
        codex: { kind: 'home', home: '/accounts/../accounts/codex-a' },
        claude: { kind: 'config-dir', configDir: '/accounts/../accounts/claude-a' },
      },
      ambientClaudeLocation('/unused'),
    );
    expect(explicit).toEqual({
      version: 1,
      codex: { version: 1, provider: 'codex', kind: 'home', home: '/accounts/codex-a' },
      claude: {
        version: 1,
        provider: 'claude',
        kind: 'config-dir',
        configDir: '/accounts/claude-a',
        projectsRoot: '/accounts/claude-a/projects',
      },
    });

    const ambient = canonicalizeProviderCredentialSet(
      captureProviderCredentialSetInput({}, '/home/operator'),
      ambientClaudeLocation('/home/operator'),
    );
    expect(ambient.claude).toEqual({
      version: 1,
      provider: 'claude',
      kind: 'ambient',
      configDirLocator: '/home/operator/.claude',
      projectsRoot: '/home/operator/.claude/projects',
    });
  });

  it('rejects relative paths, unknown fields, and unsupported providers', () => {
    expect(() =>
      canonicalizeProviderCredentialSet(
        {
          version: 1,
          codex: { kind: 'home', home: 'relative' },
          claude: { kind: 'ambient' },
        },
        ambientClaudeLocation('/home/operator'),
      ),
    ).toThrow();
    expect(() =>
      canonicalizeProviderCredentialSet(
        {
          version: 1,
          codex: { kind: 'home', home: '/codex', extra: true },
          claude: { kind: 'ambient' },
        } as never,
        ambientClaudeLocation('/home/operator'),
      ),
    ).toThrow();

    const credentials = canonicalizeProviderCredentialSet(
      captureProviderCredentialSetInput({}, '/home/operator'),
      ambientClaudeLocation('/home/operator'),
    );
    expect(() => projectProviderCredentialSource(credentials, 'other')).toThrow(
      'unsupported_provider_credential_binding',
    );
  });

  it('compares canonical source identity without conflating providers', () => {
    const credentials = canonicalizeProviderCredentialSet(
      captureProviderCredentialSetInput({}, '/home/operator'),
      ambientClaudeLocation('/home/operator'),
    );
    expect(sameProviderCredentialSource(credentials.codex, { ...credentials.codex })).toBe(true);
    expect(sameProviderCredentialSource(credentials.codex, credentials.claude)).toBe(false);
    expect(providerCredentialSourceKey(credentials.codex)).toMatch(/^codex:home:[0-9a-f]{8}$/);
    expect(providerCredentialSourceKey(credentials.codex)).not.toContain('/home/operator');
    expect(providerRoutingEnv(credentials.codex)).toEqual({ CODEX_HOME: '/home/operator/.codex' });
    expect(providerRoutingEnv(credentials.claude)).toEqual({});
  });

  it.each([
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'CLAUDE_CODE_USE_FOUNDRY',
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_CUSTOM_HEADERS',
  ])(
    'captures globally but fails a Claude launch closed for unsupported selector %s',
    (selector) => {
      const input = captureProviderCredentialSetInput({ [selector]: '1' }, '/home/operator');
      const credentials = canonicalizeProviderCredentialSet(input, ambientClaudeLocation('/home/operator'));
      expect(() =>
        buildExactProviderEnv({
          baseEnv: { [selector]: '1' },
          source: credentials.claude,
          platform: 'linux',
        }),
      ).toThrow(`Unsupported Claude credential selector '${selector}'`);
      expect(() =>
        buildExactProviderEnv({
          baseEnv: { [selector]: '1' },
          source: credentials.codex,
          platform: 'linux',
        }),
      ).not.toThrow();
    },
  );

  it('routes an explicit Claude source without leaking Codex account selection', () => {
    const credentials = canonicalizeProviderCredentialSet(
      captureProviderCredentialSetInput(
        { CODEX_HOME: '/accounts/codex-a', CLAUDE_CONFIG_DIR: '/accounts/claude-a' },
        '/home/operator',
      ),
      ambientClaudeLocation('/home/operator'),
    );
    expect(providerRoutingEnv(credentials.claude)).toEqual({ CLAUDE_CONFIG_DIR: '/accounts/claude-a' });
  });

  it('checks that a persisted credential root still exists and is readable', () => {
    const readableRoots = new Set(['/accounts/codex-a']);
    const availability = filesystemProviderCredentialSourceAvailability({
      statSync: ((path: string) => {
        if (!readableRoots.has(path)) throw new Error('missing');
        return { isDirectory: () => true };
      }) as never,
      readdirSync: ((path: string) => {
        if (!readableRoots.has(path)) throw new Error('unreadable');
        return [];
      }) as never,
    });

    expect(
      availability.isAvailable({
        version: 1,
        provider: 'codex',
        kind: 'home',
        home: '/accounts/codex-a',
      }),
    ).toBe(true);
    expect(
      availability.isAvailable({
        version: 1,
        provider: 'claude',
        kind: 'config-dir',
        configDir: '/accounts/claude-missing',
        projectsRoot: '/accounts/claude-missing/projects',
      }),
    ).toBe(false);
  });
});
