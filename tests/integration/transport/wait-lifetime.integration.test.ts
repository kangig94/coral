import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { afterAll, beforeAll, expect, it } from 'vitest';

const root = resolve('.');
const directory = mkdtempSync(join(tmpdir(), 'coral-wait-lifetime-'));
const probes = [
  'observed-race',
  'ipc-reachable',
  'http-reachable',
  'dispatch-retention',
  'pump-retention',
  'disconnect-cleanup',
  'upstream-return',
  'wait-cleanup',
  'kb-exit-upgrade',
  'historical-cause',
  'hook-deferred-notice',
];

beforeAll(async () => {
  symlinkSync(join(root, 'node_modules'), join(directory, 'node_modules'), 'dir');
  await build({
    entryPoints: probes.map((name) => join(root, 'tests/fixtures/wait-lifetime', `${name}.mjs`)),
    outdir: directory,
    outExtension: { '.js': '.mjs' },
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    loader: { '.sql': 'text' },
    plugins: [
      {
        name: 'private-probe-boundaries',
        setup(builder) {
          builder.onResolve({ filter: /^#src\// }, ({ path }) => ({
            path: join(root, path.replace('#src/', 'src/').replace(/\.js$/, '.ts')),
          }));
          builder.onLoad({ filter: /(?:dispatch|server|semantic-operation-runner|follow)\.ts$/ }, ({ path }) => {
            const exports = path.endsWith('/cli/follow.ts')
              ? 'emitWaitEvent'
              : path.endsWith('/transport/dispatch.ts')
                ? 'withSuccessionHandover'
                : path.endsWith('/transport/ipc/server.ts')
                  ? 'streamSubscription'
                  : path.endsWith('/provider-proxy/semantic-operation-runner.ts')
                    ? 'createSemanticOperationEventPump, createStagedOperationEntry'
                    : '';
            return {
              contents: readFileSync(path, 'utf8') + (exports ? `\nexport { ${exports} };\n` : ''),
              loader: 'ts',
            };
          });
        },
      },
    ],
  });
});

afterAll(() => rmSync(directory, { recursive: true, force: true }));

it.each(probes)(
  '%s preserves stream lifetime and historical evidence',
  (name) => {
    const home = mkdtempSync(join(directory, 'home-'));
    const output = execFileSync(
      process.execPath,
      [
        '--expose-gc',
        join(directory, `${name}.mjs`),
        ...(name === 'hook-deferred-notice' ? [join(root, 'clients/hooks/session-start.mjs')] : []),
      ],
      {
        cwd: root,
        env: { PATH: process.env.PATH, HOME: home, LANG: 'C.UTF-8', TMPDIR: '/tmp' },
        encoding: 'utf8',
        timeout: 20_000,
      },
    );
    expect(output).not.toContain('AssertionError');
  },
  30_000,
);

it('legacy IPC collects consumed events while the wait stays open', () => {
  const home = mkdtempSync(join(directory, 'home-'));
  const output = execFileSync(
    process.execPath,
    ['--expose-gc', join(directory, 'ipc-reachable.mjs'), '10000', 'legacy'],
    { env: { PATH: process.env.PATH, HOME: home, LANG: 'C.UTF-8', TMPDIR: '/tmp' }, encoding: 'utf8', timeout: 20_000 },
  );
  expect(output).toContain('"supportsHandover":false');
}, 30_000);
