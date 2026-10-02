import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';
import { afterEach, describe, expect, it } from 'vitest';

import type { ProviderBindingRuntime } from '#src/providers/contracts/binding.js';
import { createBuiltInProviderRegistry as createUnconnectedBuiltInProviderRegistry } from '#src/providers/bootstrap.js';
import { providerLookupPortFromCatalog } from '#src/providers/catalog.js';
import { SessionManager } from '#src/sessions/shell.js';
import { openTestStoreDb } from '#tests/helpers/store-db.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';

const roots: string[] = [];
const runtime: ProviderBindingRuntime = { readFileSync, readdirSync, realpathSync, statSync };

function createBuiltInProviderRegistry() {
  const registry = createUnconnectedBuiltInProviderRegistry();
  registry.connectAppServerHost({
    openSession: async () => {
      throw new Error('binding lifecycle fixture does not open app-server sessions');
    },
    attachSession: async () => null,
  });
  return registry;
}

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'coral-binding-'));
  roots.push(root);
  return root;
}

function writeCodexAuth(home: string, tokens: Record<string, unknown>): void {
  writeFileSync(join(home, 'auth.json'), JSON.stringify({ tokens }), 'utf8');
}

function jwt(claims: Record<string, unknown>): string {
  return `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('provider binding lifecycle', () => {
  it('captures caller defaults as physically canonical profiles before transport', async () => {
    const root = fixtureRoot();
    const physicalCodex = join(root, 'physical-codex');
    const physicalClaude = join(root, 'physical-claude');
    mkdirSync(physicalCodex);
    mkdirSync(physicalClaude);
    symlinkSync(physicalCodex, join(root, '.codex'));
    symlinkSync(physicalClaude, join(root, '.claude'));
    writeCodexAuth(physicalCodex, { account_id: 'acct-caller' });
    const registry = createBuiltInProviderRegistry();

    const result = await registry.captureScope(
      { origin: 'caller' },
      ['codex', 'claude'],
      { env: {}, homeDir: root },
      runtime,
    );

    expect(result).toEqual({
      ok: true,
      value: {
        origin: 'caller',
        profiles: [
          {
            provider: 'codex',
            profile: { canonicalLocation: physicalCodex, routing: { kind: 'home' } },
          },
          {
            provider: 'claude',
            profile: {
              canonicalLocation: physicalClaude,
              routing: { kind: 'config-dir', emitConfigDir: false, homeDir: root },
            },
          },
        ],
      },
    });
  });

  it.each([['model_provider = "proxy"', 'model_provider']])(
    'rejects Codex config routing override %s before binding',
    async (config, selector) => {
      const root = fixtureRoot();
      const codexHome = join(root, 'codex');
      mkdirSync(codexHome);
      writeCodexAuth(codexHome, { account_id: 'acct-config' });
      writeFileSync(join(codexHome, 'config.toml'), config, 'utf8');
      const registry = createBuiltInProviderRegistry();
      const profile = await registry.captureProfiles(
        ['codex'],
        { env: { CODEX_HOME: codexHome }, homeDir: root },
        runtime,
      );
      if (!profile.ok) throw new Error('expected profile capture');

      const result = await registry.bindProfile('codex', profile.value[0], runtime);

      expect(result).toEqual({
        ok: false,
        failure: {
          reason: 'unsupported-selection',
          provider: 'codex',
          selector: `Codex config transport override '${selector}'`,
        },
      });
    },
  );

  it('accepts an explicit ChatGPT auth mode with a verified workspace subject', async () => {
    const root = fixtureRoot();
    const codexHome = join(root, 'codex');
    mkdirSync(codexHome);
    writeFileSync(
      join(codexHome, 'auth.json'),
      JSON.stringify({ auth_mode: 'chatgpt', tokens: { account_id: 'acct-chatgpt' } }),
      'utf8',
    );
    const registry = createBuiltInProviderRegistry();
    const profiles = await registry.captureProfiles(
      ['codex'],
      { env: { CODEX_HOME: codexHome }, homeDir: root },
      runtime,
    );
    if (!profiles.ok) throw new Error('expected profile capture');

    await expect(registry.bindProfile('codex', profiles.value[0], runtime)).resolves.toMatchObject({ ok: true });
  });

  it('binds Codex to tokens.account_id and rejects a changed subject on reverification', async () => {
    const root = fixtureRoot();
    const codexHome = join(root, '.codex');
    const claudeHome = join(root, '.claude');
    mkdirSync(codexHome);
    mkdirSync(claudeHome);
    writeCodexAuth(codexHome, { account_id: 'acct-one', access_token: 'never-persist-me' });
    const registry = createBuiltInProviderRegistry();
    const captured = await registry.captureProfiles(['codex'], { env: {}, homeDir: root }, runtime);
    expect(captured.ok).toBe(true);
    if (!captured.ok) return;
    const profile = captured.value.find((candidate) => candidate.provider === 'codex');

    const result = await registry.bindProfile('codex', profile, runtime);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.envelope).toEqual({
      provider: 'codex',
      kind: 'account',
      binding: {
        profile: { canonicalLocation: codexHome, routing: { kind: 'home' } },
        subject: { issuer: 'https://api.openai.com/chatgpt-account', subject: 'acct-one' },
      },
    });
    expect(JSON.stringify(result.value.envelope)).not.toContain('never-persist-me');
    expect(result.value.compareIdentity(result.value.envelope)).toEqual({ ok: true, value: true });
    expect(
      result.value.compareIdentity({
        provider: 'codex',
        kind: 'account',
        binding: {
          profile: { canonicalLocation: codexHome, routing: { kind: 'home' } },
          subject: { issuer: 'https://api.openai.com', subject: 'acct-two' },
        },
      }),
    ).toEqual({ ok: false, failure: { reason: 'subject-mismatch', provider: 'codex' } });
    const codexExecution = result.value.prepareExecution({
      request: {
        action: 'exec',
        sessionId: 'codex-session',
        prompt: 'test',
        cwd: fixtureCanonicalWorkDir(root),
        bypassPermissions: false,
        coralEnv: {},
      },
      baseEnv: { PATH: '/bin' },
      storage: { existsSync: () => false },
      platform: 'linux',
    });
    expect(codexExecution.kind).toBe('app-server');
    expect(codexExecution).not.toHaveProperty('prepareCliRequest');

    writeCodexAuth(codexHome, { account_id: 'acct-two' });
    await expect(result.value.readiness('recovery', runtime)).resolves.toEqual({
      ok: false,
      failure: { reason: 'subject-mismatch', provider: 'codex' },
    });
  });

  it('discards sentinel-bearing credential I/O errors before rendering a Codex failure', async () => {
    const root = fixtureRoot();
    const codexHome = join(root, '.codex');
    mkdirSync(codexHome);
    const secretPath = '/accounts/private/sentinel-profile';
    const secretToken = 'sentinel-access-token-from-io-error';
    const registry = createBuiltInProviderRegistry();
    const throwingRuntime: ProviderBindingRuntime = {
      ...runtime,
      readFileSync(path, encoding) {
        if (path === join(codexHome, 'auth.json')) {
          throw new Error(`cannot read ${secretPath}: ${secretToken}`);
        }
        return runtime.readFileSync(path, encoding);
      },
    };
    const captured = await registry.captureProfiles(['codex'], { env: {}, homeDir: root }, throwingRuntime);
    expect(captured.ok).toBe(true);
    if (!captured.ok) return;

    const bound = await registry.bindProfile('codex', captured.value[0], throwingRuntime);
    expect(bound).toEqual({
      ok: false,
      failure: { reason: 'identity-unavailable', provider: 'codex' },
    });
    if (bound.ok) return;

    const rendered = registry.renderBindingFailure(bound.failure);
    expect(rendered).toContain('Authenticate that CODEX_HOME and retry');
    expect(rendered).not.toContain(secretPath);
    expect(rendered).not.toContain(secretToken);
  });

  it('never persists auth tokens or unrelated identity claims in Journal or session projections', async () => {
    const root = fixtureRoot();
    const codexHome = join(root, '.codex');
    mkdirSync(codexHome);
    const secret = 'sentinel-access-token-must-never-be-durable';
    writeCodexAuth(codexHome, {
      account_id: 'workspace-durable',
      access_token: secret,
      id_token: jwt({ email: 'private@example.test' }),
    });
    const registry = createBuiltInProviderRegistry();
    const captured = await registry.captureProfiles(['codex'], { env: {}, homeDir: root }, runtime);
    expect(captured.ok).toBe(true);
    if (!captured.ok) return;
    const bound = await registry.bindProfile('codex', captured.value[0], runtime);
    expect(bound.ok).toBe(true);
    if (!bound.ok) return;

    const storeRuntime = new SimulationRuntime();
    const db = openTestStoreDb(storeRuntime, ':memory:');
    new SessionManager(root, storeRuntime, undefined, undefined, db, providerLookupPortFromCatalog(registry)).allocate({
      binding: bound.value.envelope,
      name: 'durable-secret-boundary',
      cwd: root,
      projectRoot: root,
      backendNamespace: 'binding-secret-test',
    });

    const eventBodies = db.prepare('SELECT body FROM events').all() as Array<{ body: Buffer }>;
    const projections = db.prepare('SELECT entry FROM projection_sessions').all() as Array<{ entry: string }>;
    const durableBytes = [
      ...eventBodies.map(({ body }) => body.toString('utf8')),
      ...projections.map(({ entry }) => entry),
    ].join('\n');
    expect(durableBytes).toContain('workspace-durable');
    expect(durableBytes).not.toContain(secret);
    expect(durableBytes).not.toContain('private@example.test');
    db.close();
  });
});
