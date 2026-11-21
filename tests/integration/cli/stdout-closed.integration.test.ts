import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { afterAll, beforeAll, expect, it } from 'vitest';

const root = resolve('.');
const directory = mkdtempSync(join(tmpdir(), 'coral-stdout-closed-'));
const bundle = join(directory, 'cli.cjs');

const command = `
import { followJobs } from ${JSON.stringify(join(root, 'src/cli/follow.ts'))};
import { emitError } from ${JSON.stringify(join(root, 'src/cli/emit.ts'))};
const timing = { origin: 'runtime', originAt: '2026-10-07T00:00:00Z', emittedAt: '2026-10-07T00:00:01Z', elapsedMs: 1 };
export async function runCli() {
  process.exitCode = await followJobs({
    jobIds: ['job-a'],
    projectRoot: ${JSON.stringify(directory)},
    emitError,
    render: { isTTY: false, columns: 80, embed: false, verbose: false },
    connect: async ({ signal }) => ({
      close: async () => {},
      async *[Symbol.asyncIterator]() {
        if (process.argv.includes('--signal-fixture')) {
          yield { type: 'cursor', cursor: '7' };
          yield { type: 'progress', jobId: 'job-a', seq: 7, message: 'signal-ready', timing };
          if (signal.aborted) return;
          const keepAlive = setInterval(() => {}, 1000);
          await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
          clearInterval(keepAlive);
          return;
        }
        for (let seq = 1; seq <= 64; seq++) {
          yield { type: 'progress', jobId: 'job-a', seq, message: 'x'.repeat(4096), timing };
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
        yield { type: 'waiting', waitingJobIds: ['job-a'], cursor: null, exitCode: 75 };
      },
    }),
  });
}
`;

beforeAll(async () => {
  symlinkSync(join(root, 'node_modules'), join(directory, 'node_modules'), 'dir');
  await build({
    entryPoints: [join(root, 'src/cli/bootstrap.ts')],
    outfile: bundle,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    packages: 'external',
    loader: { '.sql': 'text' },
    define: { 'import.meta.url': '__importMetaUrl', __VERSION__: '"0.0.0-test"' },
    banner: { js: 'var __importMetaUrl = require("url").pathToFileURL(__filename).href;' },
    logLevel: 'error',
    plugins: [
      {
        name: 'stub-command',
        setup(builder) {
          builder.onResolve({ filter: /^\.\/run\.js$/ }, ({ importer }) =>
            importer.endsWith('/src/cli/bootstrap.ts') ? { path: 'command', namespace: 'stub-command' } : undefined,
          );
          builder.onLoad({ filter: /.*/, namespace: 'stub-command' }, () => ({
            contents: command,
            loader: 'ts',
            resolveDir: root,
          }));
        },
      },
    ],
  });
});

it('flushes the latest cursor and exits 75 when the wait process receives SIGTERM', async () => {
  const child = spawn(process.execPath, [bundle, '--signal-fixture'], {
    cwd: directory,
    env: { PATH: process.env.PATH, HOME: directory, LANG: 'C.UTF-8', TMPDIR: directory },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stopped = false;
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    stdout += chunk;
    if (!stopped && stdout.includes('signal-ready')) {
      stopped = true;
      child.kill('SIGTERM');
    }
  });
  const [code, signal] = await once(child, 'close');
  expect(signal).toBeNull();
  expect(code).toBe(75);
  expect(stdout.match(/Run coral-cli jobs wait job-a --cursor 7 to continue waiting\./g)).toHaveLength(1);
});

afterAll(() => rmSync(directory, { recursive: true, force: true }));

it('ends a wait whose stdout reader closed with the transient exit and no stack trace', async () => {
  const child = spawn(process.execPath, [bundle], {
    cwd: directory,
    env: { PATH: process.env.PATH, HOME: directory, LANG: 'C.UTF-8', TMPDIR: directory },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.destroy();
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
  const [code] = (await once(child, 'close')) as [number | null];
  expect(stderr).not.toContain("Unhandled 'error' event");
  expect(stderr).not.toMatch(/^\s+at /m);
  expect(stderr).toContain('Wait output could not be delivered');
  expect(code).toBe(75);
});
