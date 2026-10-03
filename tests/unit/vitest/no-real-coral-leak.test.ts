import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

const homes: string[] = [];
afterEach(() => {
  vi.doUnmock('node:os');
  vi.resetModules();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

it.each(['projects', 'projects-dev', 'gen2/run/custody.v1', 'gen2/data/store/epoch-1', 'exports/jobs/existing'])(
  'rejects new nested entries under the runner home at %s',
  async (subtree) => {
    const home = mkdtempSync(join(tmpdir(), 'coral-leak-guard-'));
    homes.push(home);
    const dir = join(home, '.coral', subtree);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'existing'), 'fixture');
    vi.doMock('node:os', async (original) => ({ ...(await original<Record<string, unknown>>()), homedir: () => home }));
    const { default: setup } = await import('../../../vitest/no-real-coral-leak.js');
    const check = setup();
    expect(check).not.toThrow();
    writeFileSync(join(dir, 'new'), 'fixture');
    expect(check).toThrow('Tests leaked 1 entry into the real ~/.coral tree');
  },
);
