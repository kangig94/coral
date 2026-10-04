import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { afterAll, beforeAll, expect, it } from 'vitest';

const root = resolve('.');
const directory = mkdtempSync(join(tmpdir(), 'coral-wait-phase-a-'));

beforeAll(async () => {
  symlinkSync(join(root, 'node_modules'), join(directory, 'node_modules'), 'dir');
  for (const variant of ['real', 'ungated-handover', 'include-missing', 'property-decoder', 'unbounded-observer']) {
    await build({
      entryPoints: [join(root, 'tests/fixtures/wait-lifetime/phase-a.mjs')],
      outfile: join(directory, `${variant}.mjs`),
      bundle: true,
      platform: 'node',
      format: 'esm',
      packages: 'external',
      loader: { '.sql': 'text' },
      plugins: [
        {
          name: 'phase-a-controls',
          setup(builder) {
            builder.onResolve({ filter: /^#src\// }, ({ path }) => ({
              path: join(root, path.replace('#src/', 'src/').replace(/\.js$/, '.ts')),
            }));
            builder.onResolve({ filter: /^#tools\// }, ({ path }) => ({
              path: join(root, path.replace('#tools/', 'tools/').replace(/\.js$/, '.ts')),
            }));
            builder.onLoad({ filter: /(?:handler|dispatch|wait-cursor|wait-session|wait)\.ts$/ }, ({ path }) => {
              let source = readFileSync(path, 'utf8');
              if (variant === 'unbounded-observer' && path.endsWith('/jobs/shell/wait.ts'))
                source = source.replace(
                  'const timeout = timeoutWaiter.promise;',
                  'const timeout = new Promise<never>(() => {});',
                );
              if (variant === 'ungated-handover' && path.endsWith('/http/handler.ts')) {
                source =
                  "import { raceWithSignal } from '../../infra/promise-signal.js';\n" +
                  source.replace(
                    'const next = await iterator.next();',
                    "const next = await raceWithSignal(iterator.next(), deps.jobs.waitHandoverSignal(), () => ({ done: false, value: { type: 'handover' } }));",
                  );
              }
              if (variant === 'include-missing' && path.endsWith('/jobs/wait-session.ts'))
                source = source.replace(
                  "job.disposition === 'discovery-unknown' ||",
                  "job.disposition === 'missing' || job.disposition === 'discovery-unknown' ||",
                );
              if (variant === 'property-decoder' && path.endsWith('/jobs/wait-cursor.ts'))
                source = source.replace(
                  "if (!isRecord(value)) return rejected('wait_cursor_malformed');",
                  "if (!isRecord(value)) return rejected('wait_cursor_malformed'); if ('afterSeq' in value) return { kind: 'decoded', cursor: value as WaitCursor };",
                );
              return { contents: source, loader: 'ts' };
            });
          },
        },
      ],
    });
  }
});

afterAll(() => rmSync(directory, { recursive: true, force: true }));

function probe(transport: string, scenario: string, variant = 'real'): string {
  return execFileSync(process.execPath, [join(directory, `${variant}.mjs`), transport, scenario], {
    env: { PATH: process.env.PATH, HOME: mkdtempSync(join(directory, 'home-')), LANG: 'C.UTF-8', TMPDIR: '/tmp' },
    encoding: 'utf8',
    timeout: 10_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

it.each(['http', 'ipc'])('%s uses the shared negotiated handover path', (transport) => {
  expect(probe(transport, 'negotiated')).toContain('handover');
  expect(probe(transport, 'legacy')).not.toContain('"type":"handover"');
});

it.each(['http', 'ipc'])('%s excludes a missing sibling from the exact continuation', (transport) => {
  expect(probe(transport, 'missing')).not.toContain('ghost');
});

it('HTTP softly rejects unknown header cursor generations', () => {
  expect(probe('http', 'unknown-header')).toContain('unknown-header');
});

it('the server deadline bounds an observer that never resolves', () => {
  expect(() => probe('ipc', 'observer')).not.toThrow();
});

it.each([
  ['http', 'legacy', 'ungated-handover'],
  ['http', 'missing', 'include-missing'],
  ['ipc', 'codec', 'property-decoder'],
  ['ipc', 'observer', 'unbounded-observer'],
])('negative control %s/%s/%s fails its contract assertion', (transport, scenario, variant) => {
  try {
    probe(transport, scenario, variant);
    expect.fail('Control passed its contract assertion');
  } catch (error: unknown) {
    expect(error).toMatchObject({ status: 1, stderr: expect.stringContaining('AssertionError') });
  }
});
