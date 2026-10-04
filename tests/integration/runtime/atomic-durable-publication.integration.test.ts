import { pathToFileURL } from 'node:url';
import { execFile, execFileSync, spawn } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createRealRuntime } from '#src/runtime/real.js';

const root = resolve('.');
const directory = mkdtempSync(join(tmpdir(), 'coral-atomic-publication-'));
const fixture = join(root, 'tests/fixtures/atomic-publication/writer.cjs');
const runFile = promisify(execFile);
const env = () => ({
  PATH: process.env.PATH,
  HOME: mkdtempSync(join(directory, 'home-')),
  LANG: 'C.UTF-8',
  TMPDIR: '/tmp',
});

beforeAll(async () => {
  symlinkSync(join(root, 'node_modules'), join(directory, 'node_modules'), 'dir');
  for (const variant of ['real', 'shared', 'sweep']) {
    await build({
      entryPoints: [join(root, 'src/runtime/real.ts')],
      outfile: join(directory, `${variant}.cjs`),
      define: {
        'import.meta.url': JSON.stringify(pathToFileURL(join(root, 'src/runtime/wrapper-entrypoint.ts')).href),
      },
      bundle: true,
      platform: 'node',
      format: 'cjs',
      packages: 'external',
      loader: { '.sql': 'text' },
      plugins: [
        {
          name: 'publication-controls',
          setup(builder) {
            builder.onLoad({ filter: /src\/runtime\/real\.ts$/ }, ({ path }) => {
              let source = readFileSync(path, 'utf8');
              if (variant === 'shared')
                source = source
                  .replace('`${path}.stage-${process.pid}-${++durableStageCounter}-${randomUUID()}`', '`${path}.tmp`')
                  .replaceAll("openSync(tempPath, 'wx'", "openSync(tempPath, 'w'");
              if (variant === 'sweep')
                source = source.replace(
                  '  let ownsStage = false;',
                  `
            for (const sibling of readdirSync(parent)) {
              const stage = join(parent, sibling);
              if (sibling.includes('.stage-') && Date.now() - statSync(stage).mtimeMs > 86400000) unlinkSync(stage);
            }
            let ownsStage = false;`,
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

it('publishes two processes × 400 writes of 300 KB without failed writes or invalid files', async () => {
  const target = join(directory, 'concurrent.json');
  writeFileSync(target, JSON.stringify({ padding: 'x'.repeat(300_000), writer: 0, i: 0 }));
  const results = await Promise.all(
    [1, 2].map(() =>
      runFile(process.execPath, [fixture, join(directory, 'real.cjs'), target, 'concurrent'], {
        env: env(),
        timeout: 90_000,
      }),
    ),
  );
  for (const result of results) expect(JSON.parse(result.stdout)).toEqual({ failed: 0, invalid: 0, count: 400 });
  expect(readdirSync(directory).filter((name) => name.includes('.stage-'))).toEqual([]);
});

it.each(['real', 'shared'])('held-fd corruption control: %s', (variant) => {
  const target = join(directory, `${variant}-held.json`);
  const stage = `${target}.tmp`;
  const fd = openSync(stage, 'w');
  try {
    writeSync(fd, Buffer.from('original'));
    execFileSync(process.execPath, [fixture, join(directory, `${variant}.cjs`), target, 'once'], {
      env: env(),
      timeout: 10_000,
    });
    writeSync(fd, Buffer.from('CORRUPTED'), 0, 9, 0);
    if (variant === 'shared') expect(() => JSON.parse(readFileSync(target, 'utf8'))).toThrow(SyntaxError);
    else expect(JSON.parse(readFileSync(target, 'utf8')).padding).toHaveLength(300_000);
  } finally {
    closeSync(fd);
  }
});

it.each(['real', 'sweep'])('a paused writer still owns its stage after 25 hours: %s', async (variant) => {
  const target = join(directory, `aged-${variant}.json`);
  const ready = join(directory, `ready-${variant}`);
  const release = join(directory, `release-${variant}`);
  const child = spawn(process.execPath, [fixture, join(directory, 'real.cjs'), target, 'held', ready, release], {
    env: env(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const ending = new Promise<number | null>((resolveEnd, reject) => {
    child.once('error', reject);
    child.once('exit', resolveEnd);
  });
  try {
    const deadline = Date.now() + 10_000;
    while (!existsSync(ready) && Date.now() < deadline) await delay(10);
    expect(existsSync(ready)).toBe(true);
    const stage = readFileSync(ready, 'utf8');
    expect(stage).toMatch(/\.stage-\d+-\d+-[a-f0-9-]+$/);
    expect(stage.endsWith('.json')).toBe(false);
    const aged = new Date(Date.now() - 25 * 3_600_000);
    utimesSync(stage, aged, aged);
    await runFile(process.execPath, [fixture, join(directory, `${variant}.cjs`), target, 'once'], {
      env: env(),
      timeout: 10_000,
    });
    expect(existsSync(stage)).toBe(variant === 'real');
    writeFileSync(release, 'resume');
    expect(await ending).toBe(variant === 'real' ? 0 : 1);
    if (variant === 'sweep') expect(stderr).toContain('owned publication failed');
  } finally {
    child.kill('SIGKILL');
  }
});

it('cleans only its own stage when publication fails', () => {
  const target = join(directory, 'directory-target');
  const runtime = createRealRuntime('prod', { baseDir: directory });
  runtime.storage.mkdirSync(target);
  const sibling = `${target}.stage-paused-writer`;
  writeFileSync(sibling, 'still owned');
  expect(() => runtime.storage.writeAtomicDurableSync(target, 'content')).toThrow();
  expect(readdirSync(directory).filter((name) => name.startsWith('directory-target.stage-'))).toEqual([
    'directory-target.stage-paused-writer',
  ]);
});
