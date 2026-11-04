import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { buildSync } from 'esbuild';
import { expect, it } from 'vitest';
import { createPluginFixture } from '#tests/integration/coordinator/helpers.js';

it.each([false, true])('handles a deleted invoking directory (missing run dir: %s)', async (removeRunDir) => {
  const roots: string[] = [];
  const root = mkdtempSync(join(tmpdir(), 'coral-deleted-cwd-'));
  roots.push(root);
  try {
    const fixture = createPluginFixture(roots, { flavor: 'prod' });
    const harness = join(root, 'spawn.cjs');
    buildSync({
      entryPoints: [fileURLToPath(new URL('./fixtures/deleted-launch-cwd.ts', import.meta.url))],
      outfile: harness,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      external: ['node:*'],
      banner: { js: 'var __importMetaUrl=require("url").pathToFileURL(__filename).href;' },
      define: { 'import.meta.url': '__importMetaUrl' },
    });
    const invokingDir = join(root, 'worktree');
    const runDir = join(root, 'run');
    mkdirSync(invokingDir);
    mkdirSync(runDir);
    const execution = promisify(execFile)(
      process.execPath,
      [harness, join(fixture.root, 'bridge', 'coral-backend.cjs'), runDir, invokingDir, removeRunDir ? '1' : '0'],
      { cwd: invokingDir, timeout: 15_000 },
    );
    if (removeRunDir) {
      await expect(execution).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining(`cwd ${JSON.stringify(runDir)} is unavailable`),
      });
    } else {
      const result = await execution;
      expect(result.stdout.trim()).not.toBe('');
      expect(result.stderr).not.toContain('Coordinator spawn failed');
    }
  } finally {
    for (const path of roots) rmSync(path, { recursive: true, force: true });
  }
});

it('pins the supervisor startup cwd after its invoking directory is deleted', async () => {
  const root = mkdtempSync(join(tmpdir(), 'coral-supervisor-startup-cwd-'));
  try {
    const harness = join(root, 'supervisor.cjs');
    buildSync({
      entryPoints: [fileURLToPath(new URL('./fixtures/supervisor-startup-cwd.ts', import.meta.url))],
      outfile: harness,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      external: ['node:*'],
      banner: { js: 'var __importMetaUrl=require("url").pathToFileURL(__filename).href;' },
      define: { 'import.meta.url': '__importMetaUrl' },
    });
    const invokingDir = join(root, 'worktree');
    const runDir = join(root, 'run');
    mkdirSync(invokingDir);
    const result = await promisify(execFile)(
      process.execPath,
      [harness, join(root, 'missing-backend.cjs'), runDir, invokingDir],
      {
        cwd: invokingDir,
        timeout: 15_000,
        env: {
          ...process.env,
          DBUS_SESSION_BUS_ADDRESS: `unix:path=${join(root, 'missing-bus')}`,
          XDG_RUNTIME_DIR: root,
        },
      },
    );
    expect(result.stdout).toBe(runDir);
    expect(result.stderr).toBe('');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
