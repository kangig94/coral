import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as NodeFs from 'node:fs';

let mockInjectMd = '';
let mockInjectMdError: Error | null = null;

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof NodeFs>('node:fs');
  return {
    ...actual,
    readFileSync: vi.fn((path: string, encoding?: string) => {
      if (typeof path === 'string' && path.endsWith('INJECT.md')) {
        if (mockInjectMdError) throw mockInjectMdError;
        return mockInjectMd;
      }
      return actual.readFileSync(path, encoding as BufferEncoding);
    }),
  };
});

vi.mock('#src/kb/paths.js', async () => {
  const actual = await vi.importActual<typeof import('#src/kb/paths.js')>('#src/kb/paths.js');
  return {
    ...actual,
    kbRoot: () => '/mock/kb',
  };
});

vi.mock('#src/infra/project-source.js', () => ({
  projectDataDir: (dir: string) => `/mock/projects/${dir.replace(/\//g, '-')}`,
  resolveProjectSource: () => 'mock/source',
}));

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

    const result = resolveInjectMd({ workingDirectory: '/wd', ownerSessionId: 'valid-session-123' });
    expect(result).toContain('base');
    expect(result).not.toContain('owner only');
    expect(result).toContain('rest');
  });

  it('keeps SESSION_ID_ONLY blocks when owner is valid', async () => {
    mockInjectMd = 'base\n<!-- SESSION_ID_ONLY:BEGIN -->\nsession content\n<!-- SESSION_ID_ONLY:END -->\nrest';
    const resolveInjectMd = await loadResolve();

    const result = resolveInjectMd({ workingDirectory: '/wd', ownerSessionId: 'valid-session-123' });
    expect(result).toContain('session content');
  });

  it('strips SESSION_ID_ONLY blocks when no owner', async () => {
    mockInjectMd = 'base\n<!-- SESSION_ID_ONLY:BEGIN -->\nsession content\n<!-- SESSION_ID_ONLY:END -->\nrest';
    const resolveInjectMd = await loadResolve();

    const result = resolveInjectMd({ workingDirectory: '/wd' });
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

    const result = resolveInjectMd({ workingDirectory: '/wd' });
    expect(result).toContain('top');
    expect(result).not.toContain('owner stuff');
    expect(result).toContain('middle');
    expect(result).not.toContain('session stuff');
    expect(result).toContain('bottom');
  });

  it('substitutes {{SESSION_ID}} with owner value', async () => {
    mockInjectMd = 'owner: {{SESSION_ID}}';
    const resolveInjectMd = await loadResolve();

    const result = resolveInjectMd({ workingDirectory: '/wd', ownerSessionId: 'my-session' });
    expect(result).toContain('owner: my-session');
  });

  it('returns empty string when INJECT.md is missing', async () => {
    mockInjectMdError = Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
    const resolveInjectMd = await loadResolve();

    const result = resolveInjectMd({ workingDirectory: '/wd', ownerSessionId: 'sess' });
    expect(result).toBe('');
  });
});
