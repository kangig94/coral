import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { afterAll, beforeAll, expect, it } from 'vitest';

const root = mkdtempSync(join(tmpdir(), 'coral-startup-owned-operation-'));
const bundle = join(root, 'probe.mjs');

beforeAll(async () => {
  await build({
    entryPoints: [fileURLToPath(new URL('./fixtures/startup-owned-operation.ts', import.meta.url))],
    outfile: bundle,
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'esm',
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
    external: ['node:*', '@lydell/node-pty'],
    loader: { '.sql': 'text' },
    plugins: [
      {
        name: 'standalone-harness-functions',
        setup(builder) {
          builder.onResolve({ filter: /^vitest$/ }, () => ({ path: 'vitest', namespace: 'standalone' }));
          builder.onLoad({ filter: /.*/, namespace: 'standalone' }, () => ({
            contents: 'export const vi = { fn: (implementation = () => undefined) => implementation };',
          }));
        },
      },
    ],
  });
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

function probe(mode: string) {
  return spawnSync(process.execPath, [bundle, mode], {
    env: { PATH: process.env.PATH, HOME: root, LANG: 'C.UTF-8', TMPDIR: root, CORAL_TEST_TIER: 'integration' },
    encoding: 'utf8',
    timeout: 10_000,
  });
}

it.each(['abort-rekey', 'abort-run', 'begin', 'control-established'])(
  '%s respects detached startup ownership under default Node rejection handling',
  (mode) => {
    const result = probe(mode);
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status, result.stderr).toBe(0);
  },
);

it('negative control terminates on an unobserved startup-ownership rejection', () => {
  const result = probe('negative-control');
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('ProviderOperationMutationSetClosedError');
  expect(result.stderr).not.toContain('Node must terminate');
});
