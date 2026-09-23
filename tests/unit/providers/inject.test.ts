import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';

let mockCoreFragment = '';
let mockFragmentError: Error | null = null;

const mockStorage = {
  readFileSync: vi.fn((path: string, _encoding: 'utf-8') => {
    if (mockFragmentError) throw mockFragmentError;
    if (path.endsWith('/inject/core.md')) return mockCoreFragment;
    if (path.endsWith('/inject/tools.md')) return '';
    throw new Error(`unexpected read: ${path}`);
  }),
};

beforeEach(() => {
  mockCoreFragment = '';
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

describe('provider inject bundle content', () => {
  it('should tell a provider session nothing about the Coral CLI, the KB, or launching agents', async () => {
    vi.stubGlobal('__PLUGIN_ROOT__', join(process.cwd(), 'clients'));
    const resolveInjectBundle = await loadResolve();

    const result = resolveInjectBundle({
      storage: { readFileSync: (path: string) => readFileSync(path, 'utf-8') },
      coralProjects: '/mock/projects/acme-repo',
    });

    expect(result).toContain('CORAL_METHODS/');
    expect(result).not.toContain('coral-cli');
    expect(result).not.toContain('CLI');
    expect(result).not.toContain('kb ');
    expect(result).not.toContain('<agent> -i');
  });
});

describe('resolveInjectBundle', () => {
  it('returns empty string when an inject fragment is missing', async () => {
    mockFragmentError = Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
    const resolveInjectBundle = await loadResolve();

    expect(resolveInjectBundle({ storage: mockStorage })).toBe('');
  });

  it('strips the {{EQUIPPED_TOOLS}} placeholder when caller omits equipped tools', async () => {
    mockCoreFragment = 'before{{EQUIPPED_TOOLS}}\nafter';
    const resolveInjectBundle = await loadResolve();

    const result = resolveInjectBundle({ storage: mockStorage });
    expect(result).not.toContain('{{EQUIPPED_TOOLS}}');
    expect(result).toContain('after');
  });

  it('renders equipped tools when caller provides them', async () => {
    mockCoreFragment = 'before\n\n{{EQUIPPED_TOOLS}}\n\nafter';
    const resolveInjectBundle = await loadResolve();

    const result = resolveInjectBundle({
      storage: mockStorage,
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

  it('substitutes {{CORAL_METHODS}} from plugin root with a trailing slash', async () => {
    mockCoreFragment = 'methods: {{CORAL_METHODS}}';
    const resolveInjectBundle = await loadResolve();

    const result = resolveInjectBundle({ storage: mockStorage });
    expect(result).toMatch(/methods: .+\/methods\/$/);
    expect(result).not.toContain('{{CORAL_METHODS}}');
  });

  it('substitutes {{CORAL_PROJECT}} from caller-resolved project data dir', async () => {
    mockCoreFragment = 'project: {{CORAL_PROJECT}}';
    const resolveInjectBundle = await loadResolve();

    const result = resolveInjectBundle({ storage: mockStorage, coralProjects: '/mock/projects/acme-repo' });
    expect(result).toContain('project: /mock/projects/acme-repo');
  });

  it('leaves {{CORAL_PROJECT}} placeholder when caller omits project data dir', async () => {
    mockCoreFragment = 'project: {{CORAL_PROJECT}}';
    const resolveInjectBundle = await loadResolve();

    const result = resolveInjectBundle({ storage: mockStorage });
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
    return { storage: mockStorage, ...overrides };
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

  it('includes equipped tools when runtime supplies them', async () => {
    mockCoreFragment = 'before\n{{EQUIPPED_TOOLS}}\nafter';
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
    expect(result.systemPrompt).toContain('- codebase-memory: mandatory first stop for any code work.');
    expect(result.systemPrompt).toContain('  - Use search_graph before opening files.');
  });
});
