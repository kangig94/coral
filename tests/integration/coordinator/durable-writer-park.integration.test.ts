import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { expect, it } from 'vitest';

it.each(['recovery', 'durable'] as const)(
  '%s polling survives writer park, reclaim, and committed handoff in a real timer process',
  async (kind) => {
    const root = mkdtempSync(join(tmpdir(), 'coral-writer-park-probe-'));
    try {
      const output = join(root, 'probe.mjs');
      symlinkSync(join(process.cwd(), 'node_modules'), join(root, 'node_modules'), 'dir');
      await build({
        entryPoints: [fileURLToPath(new URL('./fixtures/writer-park.ts', import.meta.url))],
        outfile: output,
        bundle: true,
        platform: 'node',
        format: 'esm',
        packages: 'external',
        loader: { '.sql': 'text' },
        plugins: [
          {
            name: 'expose-probed-functions',
            setup(builder) {
              builder.onLoad(
                {
                  filter:
                    /\/coordinator\/(live\/durable-transport|services\/recovery\/(running-adoption|lifecycle))\.ts$/,
                },
                ({ path }) => ({
                  contents:
                    readFileSync(path, 'utf8') +
                    '\nexport { ' +
                    (path.endsWith('durable-transport.ts')
                      ? 'awaitDurableLaunchResult'
                      : path.endsWith('running-adoption.ts')
                        ? 'pollAdoptedRuntime, createRecoveredProgress'
                        : 'observeDurableRecoveryContainmentFor') +
                    ' };',
                  loader: 'ts',
                }),
              );
            },
          },
        ],
      });
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('CORAL_')));
      for (const args of kind === 'recovery'
        ? [[], ['--park'], ['--park', '--commit']]
        : [['--control'], [], ['--commit']]) {
        const result = spawnSync(process.execPath, [output, root, kind, ...args], {
          env,
          encoding: 'utf8',
          timeout: 8_000,
        });
        expect(result.status, result.stdout + result.stderr).toBe(0);
        expect(result.error).toBeUndefined();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
