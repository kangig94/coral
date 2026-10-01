import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

describe('provider proxy cleanup ownership', () => {
  it.each([{ args: [] }, { args: ['--pending-registration'] }])(
    'observes all release failures under default Node rejection behavior ($args)',
    async ({ args }) => {
      const bundle = await build({
        entryPoints: ['tests/fixtures/provider-proxy/cleanup-ownership.ts'],
        bundle: true,
        platform: 'node',
        format: 'esm',
        packages: 'external',
        write: false,
      });
      const child = spawnSync(process.execPath, ['--input-type=module', '-', ...args], {
        input: bundle.outputFiles[0].text,
        encoding: 'utf8',
        timeout: 10_000,
        env: Object.fromEntries(
          Object.entries(process.env).filter(([key]) => !key.startsWith('CORAL_') && key !== 'NODE_OPTIONS'),
        ),
      });
      expect(child.error).toBeUndefined();
      expect(child.status, child.stderr).toBe(0);
      expect(child.stdout).toContain('cleanup owned; sibling survives');
    },
  );
});
