import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as KbPathsModule from '#src/kb/paths.js';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';

let mockCoreFragment = '';
let mockKbCommon = '';
let mockKbSession = '';
let mockFragmentError: Error | null = null;

const mockStorage = {
  readFileSync: vi.fn((path: string, _encoding: 'utf-8') => {
    if (mockFragmentError) throw mockFragmentError;
    if (path.endsWith('/inject/core.md')) return mockCoreFragment;
    if (path.endsWith('/inject/tools.md')) return '';
    if (path.endsWith('/inject/kb/common.md')) return mockKbCommon;
    if (path.endsWith('/inject/kb/session.md')) return mockKbSession;
    throw new Error(`unexpected read: ${path}`);
  }),
};

vi.mock('#src/kb/paths.js', async () => {
  const actual = await vi.importActual<typeof KbPathsModule>('#src/kb/paths.js');
  return {
    ...actual,
    kbRoot: () => '/mock/kb',
  };
});

beforeEach(() => {
  mockCoreFragment = '';
  mockKbCommon = '';
  mockKbSession = '';
  mockFragmentError = null;
  mockStorage.readFileSync.mockClear();
  // Source modules use the esbuild-injected bare identifier `__PLUGIN_ROOT__`.
  // Vitest has no esbuild define for it — mirror the setup global onto the free name.
  vi.stubGlobal('__PLUGIN_ROOT__', process.cwd());
  // Reset the module-level fragment cache by re-importing.
  vi.resetModules();
});

async function loadResolve() {
  const mod = await import('#src/providers/inject.js');
  return mod.resolveInjectBundle;
}

async function loadApply() {
  const mod = await import('#src/providers/inject.js');
  return mod.applyInjectBundle;
}

describe('resolveInjectBundle', () => {
  it.each([
    {
      name: 'owned provider',
      options: { ownerSessionId: 'valid-session-123' },
      included: ['base', 'kb common', 'session content'],
    },
    { name: 'anonymous provider', options: {}, included: ['base', 'kb common'] },
    { name: 'KB-disabled provider', options: { kbEnabled: false }, included: ['base'] },
  ])('composes the $name fragment set', async ({ options, included }) => {
    mockCoreFragment = 'base';
    mockKbCommon = 'kb common';
    mockKbSession = 'session content';
    const resolveInjectBundle = await loadResolve();

    const result = resolveInjectBundle({ storage: mockStorage, kbRoot: '/mock/kb', ...options });
    for (const fragment of included) expect(result).toContain(fragment);
    for (const fragment of ['base', 'kb common', 'session content'].filter((item) => !included.includes(item))) {
      expect(result).not.toContain(fragment);
    }
  });

  it('substitutes {{SESSION_ID}} with owner value', async () => {
    mockCoreFragment = 'owner: {{SESSION_ID}}';
    const resolveInjectBundle = await loadResolve();

    const result = resolveInjectBundle({
      storage: mockStorage,
      ownerSessionId: 'my-session',
      kbRoot: '/mock/kb',
    });
    expect(result).toContain('owner: my-session');
  });

  it('returns empty string when an inject fragment is missing', async () => {
    mockFragmentError = Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
    const resolveInjectBundle = await loadResolve();

    const result = resolveInjectBundle({
      storage: mockStorage,
      ownerSessionId: 'sess',
      kbRoot: '/mock/kb',
    });
    expect(result).toBe('');
  });

  it('substitutes {{CORAL_PROJECTS}} and {{PROJECT_SOURCE}} from caller-resolved values', async () => {
    mockCoreFragment = 'projects: {{CORAL_PROJECTS}}\nsource: {{PROJECT_SOURCE}}';
    const resolveInjectBundle = await loadResolve();

    const result = resolveInjectBundle({
      storage: mockStorage,
      kbRoot: '/mock/kb',
      coralProjects: '/mock/projects/acme-repo',
      projectSource: 'acme/repo',
    });
    expect(result).toContain('projects: /mock/projects/acme-repo');
    expect(result).toContain('source: acme/repo');
  });

  it('leaves {{CORAL_PROJECTS}} and {{PROJECT_SOURCE}} placeholders when caller omits them', async () => {
    mockCoreFragment = 'projects: {{CORAL_PROJECTS}}\nsource: {{PROJECT_SOURCE}}';
    const resolveInjectBundle = await loadResolve();

    const result = resolveInjectBundle({ storage: mockStorage, kbRoot: '/mock/kb' });
    expect(result).toContain('projects: {{CORAL_PROJECTS}}');
    expect(result).toContain('source: {{PROJECT_SOURCE}}');
  });

  it('strips the {{EQUIPPED_TOOLS}} placeholder when caller omits equipped tools', async () => {
    mockCoreFragment = 'CLI: `{{CORAL_CLI}}`{{EQUIPPED_TOOLS}}\nafter';
    const resolveInjectBundle = await loadResolve();

    const result = resolveInjectBundle({ storage: mockStorage, kbRoot: '/mock/kb' });
    expect(result).not.toContain('{{EQUIPPED_TOOLS}}');
    expect(result).toContain('after');
  });

  it('renders equipped tools when caller provides them', async () => {
    mockCoreFragment = 'CLI: `{{CORAL_CLI}}`\n\n{{EQUIPPED_TOOLS}}\n\nafter';
    const resolveInjectBundle = await loadResolve();

    const result = resolveInjectBundle({
      storage: mockStorage,
      kbRoot: '/mock/kb',
      equippedTools: [
        {
          id: 'codebase-memory',
          summary: 'mandatory first stop for any code work.',
          guidance: ['Use search_graph before opening files.', 'Manual grep/read is a fallback only.'],
        },
      ],
    });
    expect(result).toContain('⚠ Equipped tools are capabilities the user explicitly installed via /equip');
    expect(result).toContain('MUST use every applicable equipped tool as the highest-priority first pass');
    expect(result).toContain('- codebase-memory: mandatory first stop for any code work.');
    expect(result).toContain('  - Use search_graph before opening files.');
    expect(result).toContain('  - Manual grep/read is a fallback only.');
    expect(result).not.toContain('{{EQUIPPED_TOOLS}}');
    expect(result).toContain('after');
  });

  it('omits KB fragments when kbEnabled is false', async () => {
    mockCoreFragment = 'top\nbottom';
    mockKbCommon = 'kb stuff';
    const resolveInjectBundle = await loadResolve();

    const result = resolveInjectBundle({ storage: mockStorage, kbRoot: '/mock/kb', kbEnabled: false });
    expect(result).toContain('top');
    expect(result).not.toContain('kb stuff');
    expect(result).toContain('bottom');
  });

  it('includes KB fragments when kbEnabled is true', async () => {
    mockCoreFragment = 'top\nbottom';
    mockKbCommon = 'kb stuff';
    const resolveInjectBundle = await loadResolve();

    const result = resolveInjectBundle({ storage: mockStorage, kbRoot: '/mock/kb', kbEnabled: true });
    expect(result).toContain('top');
    expect(result).toContain('kb stuff');
    expect(result).toContain('bottom');
  });

  it('includes KB fragments when kbEnabled is omitted (unset inherits enabled)', async () => {
    mockCoreFragment = 'top\nbottom';
    mockKbCommon = 'kb stuff';
    const resolveInjectBundle = await loadResolve();

    const result = resolveInjectBundle({ storage: mockStorage, kbRoot: '/mock/kb' });
    expect(result).toContain('kb stuff');
  });

  it('substitutes {{CORAL_METHODS}} from plugin root with a trailing slash', async () => {
    mockCoreFragment = 'methods: {{CORAL_METHODS}}';
    const resolveInjectBundle = await loadResolve();

    const result = resolveInjectBundle({ storage: mockStorage, kbRoot: '/mock/kb' });
    expect(result).toMatch(/methods: .+\/methods\/$/);
    expect(result).not.toContain('{{CORAL_METHODS}}');
  });

  it('substitutes {{CORAL_PROJECT}} from caller-resolved project data dir', async () => {
    mockCoreFragment = 'project: {{CORAL_PROJECT}}\nlegacy: {{CORAL_PROJECTS}}';
    const resolveInjectBundle = await loadResolve();

    const result = resolveInjectBundle({
      storage: mockStorage,
      kbRoot: '/mock/kb',
      coralProjects: '/mock/projects/acme-repo',
    });
    expect(result).toContain('project: /mock/projects/acme-repo');
    expect(result).toContain('legacy: /mock/projects/acme-repo');
  });

  it('leaves {{CORAL_PROJECT}} placeholder when caller omits project data dir', async () => {
    mockCoreFragment = 'project: {{CORAL_PROJECT}}';
    const resolveInjectBundle = await loadResolve();

    const result = resolveInjectBundle({ storage: mockStorage, kbRoot: '/mock/kb' });
    expect(result).toContain('project: {{CORAL_PROJECT}}');
  });
});

describe('applyInjectBundle', () => {
  const baseRequest = {
    action: 'exec' as const,
    sessionId: 's-1',
    prompt: 'task',
    cwd: fixtureCanonicalWorkDir('/tmp'),
    bypassPermissions: false,
    coralEnv: {},
  };

  function runtime(overrides: Record<string, unknown> = {}) {
    return {
      storage: mockStorage,
      kbRoot: '/mock/kb',
      ...overrides,
    };
  }

  it('is a no-op when the inject bundle is empty or missing', async () => {
    mockCoreFragment = '';
    const applyInjectBundle = await loadApply();
    const request = { ...baseRequest, systemPrompt: 'caller' };
    expect(applyInjectBundle(request, runtime())).toBe(request);
  });

  it('sets systemPrompt to inject when caller has none', async () => {
    mockCoreFragment = 'guidelines';
    const applyInjectBundle = await loadApply();
    const result = applyInjectBundle(baseRequest, runtime());
    expect(result.systemPrompt).toBe('guidelines');
    expect(result.prompt).toBe('task');
  });

  it('prepends inject and preserves caller systemPrompt (append-merge, never overwrite)', async () => {
    mockCoreFragment = 'guidelines';
    const applyInjectBundle = await loadApply();
    const result = applyInjectBundle({ ...baseRequest, systemPrompt: 'caller system' }, runtime());
    expect(result.systemPrompt).toBe('guidelines\n\ncaller system');
  });

  it('omits KB fragments when coralEnv disables KB', async () => {
    mockCoreFragment = 'top\nbottom';
    mockKbCommon = 'kb stuff';
    const applyInjectBundle = await loadApply();
    const result = applyInjectBundle({ ...baseRequest, coralEnv: { CORAL_KB_ENABLE: '0' } }, runtime());
    expect(result.systemPrompt).toContain('top');
    expect(result.systemPrompt).not.toContain('kb stuff');
    expect(result.systemPrompt).toContain('bottom');
  });

  it('includes equipped tools when runtime supplies them', async () => {
    mockCoreFragment = 'CLI\n{{EQUIPPED_TOOLS}}\nafter';
    const applyInjectBundle = await loadApply();
    const result = applyInjectBundle(
      baseRequest,
      runtime({
        equippedTools: [
          {
            id: 'codebase-memory',
            summary: 'mandatory first stop for any code work.',
            guidance: ['Use search_graph before opening files.'],
          },
        ],
      }),
    );
    expect(result.systemPrompt).toContain('⚠ Equipped tools are capabilities the user explicitly installed via /equip');
    expect(result.systemPrompt).toContain('MUST use every applicable equipped tool as the highest-priority first pass');
    expect(result.systemPrompt).toContain('- codebase-memory: mandatory first stop for any code work.');
    expect(result.systemPrompt).toContain('  - Use search_graph before opening files.');
  });
});
