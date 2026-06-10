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
  // Reset the module-level cache by re-importing
  vi.resetModules();
});

async function loadResolve() {
  const mod = await import('#src/providers/inject.js');
  return mod.resolveInjectMd;
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
});
