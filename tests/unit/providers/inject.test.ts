import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as KbPathsModule from '#src/kb/paths.js';

let mockInjectMd = '';
let mockInjectMdError: Error | null = null;

const mockStorage = {
  readFileSync: vi.fn((path: string, _encoding: 'utf-8') => {
    if (path.endsWith('INJECT.md')) {
      if (mockInjectMdError) throw mockInjectMdError;
      return mockInjectMd;
    }
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
  mockInjectMd = '';
  mockInjectMdError = null;
  // Source modules use the esbuild-injected bare identifier `__PLUGIN_ROOT__`.
  // Vitest has no esbuild define for it — mirror the setup global onto the free name.
  vi.stubGlobal('__PLUGIN_ROOT__', process.cwd());
  // Reset the module-level injectMdCache by re-importing
  vi.resetModules();
});

async function loadResolve() {
  const mod = await import('#src/providers/inject.js');
  return mod.resolveInjectMd;
}

async function loadApply() {
  const mod = await import('#src/providers/inject.js');
  return mod.applyInjectMd;
}

describe('resolveInjectMd', () => {
  it('always strips OWNER_ONLY blocks even with valid owner', async () => {
    mockInjectMd = 'base\n<!-- OWNER_ONLY:BEGIN -->\nowner only\n<!-- OWNER_ONLY:END -->\nrest';
    const resolveInjectMd = await loadResolve();

    const result = resolveInjectMd({
      storage: mockStorage,
      ownerSessionId: 'valid-session-123',
      kbRoot: '/mock/kb',
    });
    expect(result).toContain('base');
    expect(result).not.toContain('owner only');
    expect(result).toContain('rest');
  });

  it('keeps SESSION_ID_ONLY blocks when owner is valid', async () => {
    mockInjectMd = 'base\n<!-- SESSION_ID_ONLY:BEGIN -->\nsession content\n<!-- SESSION_ID_ONLY:END -->\nrest';
    const resolveInjectMd = await loadResolve();

    const result = resolveInjectMd({
      storage: mockStorage,
      ownerSessionId: 'valid-session-123',
      kbRoot: '/mock/kb',
    });
    expect(result).toContain('session content');
  });

  it('strips SESSION_ID_ONLY blocks when no owner', async () => {
    mockInjectMd = 'base\n<!-- SESSION_ID_ONLY:BEGIN -->\nsession content\n<!-- SESSION_ID_ONLY:END -->\nrest';
    const resolveInjectMd = await loadResolve();

    const result = resolveInjectMd({ storage: mockStorage, kbRoot: '/mock/kb' });
    expect(result).toContain('base');
    expect(result).not.toContain('session content');
    expect(result).toContain('rest');
  });

  it('strips both OWNER_ONLY and SESSION_ID_ONLY when no owner', async () => {
    mockInjectMd = [
      'top',
      '<!-- OWNER_ONLY:BEGIN -->',
      'owner stuff',
      '<!-- OWNER_ONLY:END -->',
      'middle',
      '<!-- SESSION_ID_ONLY:BEGIN -->',
      'session stuff',
      '<!-- SESSION_ID_ONLY:END -->',
      'bottom',
    ].join('\n');
    const resolveInjectMd = await loadResolve();

    const result = resolveInjectMd({ storage: mockStorage, kbRoot: '/mock/kb' });
    expect(result).toContain('top');
    expect(result).not.toContain('owner stuff');
    expect(result).toContain('middle');
    expect(result).not.toContain('session stuff');
    expect(result).toContain('bottom');
  });

  it('substitutes {{SESSION_ID}} with owner value', async () => {
    mockInjectMd = 'owner: {{SESSION_ID}}';
    const resolveInjectMd = await loadResolve();

    const result = resolveInjectMd({
      storage: mockStorage,
      ownerSessionId: 'my-session',
      kbRoot: '/mock/kb',
    });
    expect(result).toContain('owner: my-session');
  });

  it('returns empty string when INJECT.md is missing', async () => {
    mockInjectMdError = Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
    const resolveInjectMd = await loadResolve();

    const result = resolveInjectMd({
      storage: mockStorage,
      ownerSessionId: 'sess',
      kbRoot: '/mock/kb',
    });
    expect(result).toBe('');
  });

  it('substitutes {{CORAL_PROJECTS}} and {{PROJECT_SOURCE}} from caller-resolved values', async () => {
    mockInjectMd = 'projects: {{CORAL_PROJECTS}}\nsource: {{PROJECT_SOURCE}}';
    const resolveInjectMd = await loadResolve();

    const result = resolveInjectMd({
      storage: mockStorage,
      kbRoot: '/mock/kb',
      coralProjects: '/mock/projects/acme-repo',
      projectSource: 'acme/repo',
    });
    expect(result).toContain('projects: /mock/projects/acme-repo');
    expect(result).toContain('source: acme/repo');
  });

  it('leaves {{CORAL_PROJECTS}} and {{PROJECT_SOURCE}} placeholders when caller omits them', async () => {
    mockInjectMd = 'projects: {{CORAL_PROJECTS}}\nsource: {{PROJECT_SOURCE}}';
    const resolveInjectMd = await loadResolve();

    const result = resolveInjectMd({ storage: mockStorage, kbRoot: '/mock/kb' });
    expect(result).toContain('projects: {{CORAL_PROJECTS}}');
    expect(result).toContain('source: {{PROJECT_SOURCE}}');
  });

  it('strips the {{EQUIPPED_TOOLS}} placeholder when caller omits equipped tools', async () => {
    mockInjectMd = 'CLI: `{{CORAL_CLI}}`{{EQUIPPED_TOOLS}}\nafter';
    const resolveInjectMd = await loadResolve();

    const result = resolveInjectMd({ storage: mockStorage, kbRoot: '/mock/kb' });
    expect(result).not.toContain('{{EQUIPPED_TOOLS}}');
    expect(result).toContain('after');
  });

  it('renders equipped tools when caller provides them', async () => {
    mockInjectMd = 'CLI: `{{CORAL_CLI}}`\n\n{{EQUIPPED_TOOLS}}\n\nafter';
    const resolveInjectMd = await loadResolve();

    const result = resolveInjectMd({
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
    expect(result).toContain('mandatory first-pass capabilities');
    expect(result).toContain('Use the live MCP tools in the mcp__codebase_memory_mcp namespace');
    expect(result).toContain('- codebase-memory: mandatory first stop for any code work.');
    expect(result).toContain('  - Use search_graph before opening files.');
    expect(result).toContain('  - Manual grep/read is a fallback only.');
    expect(result).not.toContain('{{EQUIPPED_TOOLS}}');
    expect(result).toContain('after');
  });

  it('strips the KB_ONLY block when kbEnabled is false', async () => {
    mockInjectMd = 'top\n<!-- KB_ONLY:BEGIN -->\nkb stuff\n<!-- KB_ONLY:END -->\nbottom';
    const resolveInjectMd = await loadResolve();

    const result = resolveInjectMd({ storage: mockStorage, kbRoot: '/mock/kb', kbEnabled: false });
    expect(result).toContain('top');
    expect(result).not.toContain('kb stuff');
    expect(result).toContain('bottom');
  });

  it('keeps KB_ONLY content when kbEnabled is true', async () => {
    mockInjectMd = 'top\n<!-- KB_ONLY:BEGIN -->\nkb stuff\n<!-- KB_ONLY:END -->\nbottom';
    const resolveInjectMd = await loadResolve();

    const result = resolveInjectMd({ storage: mockStorage, kbRoot: '/mock/kb', kbEnabled: true });
    expect(result).toContain('top');
    expect(result).toContain('kb stuff');
    expect(result).toContain('bottom');
  });

  it('keeps KB_ONLY content when kbEnabled is omitted (unset inherits enabled)', async () => {
    mockInjectMd = 'top\n<!-- KB_ONLY:BEGIN -->\nkb stuff\n<!-- KB_ONLY:END -->\nbottom';
    const resolveInjectMd = await loadResolve();

    const result = resolveInjectMd({ storage: mockStorage, kbRoot: '/mock/kb' });
    expect(result).toContain('kb stuff');
  });

  it('substitutes {{CORAL_METHODS}} from plugin root with a trailing slash', async () => {
    mockInjectMd = 'methods: {{CORAL_METHODS}}';
    const resolveInjectMd = await loadResolve();

    const result = resolveInjectMd({ storage: mockStorage, kbRoot: '/mock/kb' });
    expect(result).toMatch(/methods: .+\/methods\/$/);
    expect(result).not.toContain('{{CORAL_METHODS}}');
  });

  it('substitutes {{CORAL_PROJECT}} from caller-resolved project data dir', async () => {
    mockInjectMd = 'project: {{CORAL_PROJECT}}\nlegacy: {{CORAL_PROJECTS}}';
    const resolveInjectMd = await loadResolve();

    const result = resolveInjectMd({
      storage: mockStorage,
      kbRoot: '/mock/kb',
      coralProjects: '/mock/projects/acme-repo',
    });
    expect(result).toContain('project: /mock/projects/acme-repo');
    expect(result).toContain('legacy: /mock/projects/acme-repo');
  });

  it('leaves {{CORAL_PROJECT}} placeholder when caller omits project data dir', async () => {
    mockInjectMd = 'project: {{CORAL_PROJECT}}';
    const resolveInjectMd = await loadResolve();

    const result = resolveInjectMd({ storage: mockStorage, kbRoot: '/mock/kb' });
    expect(result).toContain('project: {{CORAL_PROJECT}}');
  });
});

describe('applyInjectMd', () => {
  const baseRequest = {
    action: 'exec' as const,
    sessionId: 's-1',
    prompt: 'task',
    cwd: '/tmp',
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

  it('is a no-op when INJECT.md is empty/missing', async () => {
    mockInjectMd = '';
    const applyInjectMd = await loadApply();
    const request = { ...baseRequest, systemPrompt: 'caller' };
    expect(applyInjectMd(request, runtime())).toBe(request);
  });

  it('sets systemPrompt to inject when caller has none', async () => {
    mockInjectMd = 'guidelines';
    const applyInjectMd = await loadApply();
    const result = applyInjectMd(baseRequest, runtime());
    expect(result.systemPrompt).toBe('guidelines');
    expect(result.prompt).toBe('task');
  });

  it('prepends inject and preserves caller systemPrompt (append-merge, never overwrite)', async () => {
    mockInjectMd = 'guidelines';
    const applyInjectMd = await loadApply();
    const result = applyInjectMd({ ...baseRequest, systemPrompt: 'caller system' }, runtime());
    expect(result.systemPrompt).toBe('guidelines\n\ncaller system');
  });

  it('omits KB_ONLY when coralEnv disables KB', async () => {
    mockInjectMd = 'top\n<!-- KB_ONLY:BEGIN -->\nkb stuff\n<!-- KB_ONLY:END -->\nbottom';
    const applyInjectMd = await loadApply();
    const result = applyInjectMd(
      { ...baseRequest, coralEnv: { CORAL_KB_ENABLE: '0' } },
      runtime(),
    );
    expect(result.systemPrompt).toContain('top');
    expect(result.systemPrompt).not.toContain('kb stuff');
    expect(result.systemPrompt).toContain('bottom');
  });

  it('includes equipped tools when runtime supplies them', async () => {
    mockInjectMd = 'CLI\n{{EQUIPPED_TOOLS}}\nafter';
    const applyInjectMd = await loadApply();
    const result = applyInjectMd(
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
    expect(result.systemPrompt).toContain('mandatory first-pass capabilities');
    expect(result.systemPrompt).toContain('- codebase-memory: mandatory first stop for any code work.');
    expect(result.systemPrompt).toContain('  - Use search_graph before opening files.');
  });
});
