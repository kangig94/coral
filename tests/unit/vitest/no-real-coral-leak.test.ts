import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

const fixtures: string[] = [];
function removeFixture(dir: string): void {
  const denied = join(dir, 'denied');
  if (existsSync(denied)) chmodSync(denied, 0o700);
  rmSync(dir, { recursive: true, force: true });
}
afterEach(() => {
  for (const dir of fixtures.splice(0)) removeFixture(dir);
});

async function runFixture(
  dir: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  timeout = 12_000,
): Promise<{ status: number; output: string }> {
  const child = spawn('env', ['-u', 'NODE_OPTIONS', '-u', 'CORAL_TEST_WRITE_GUARD', process.execPath, ...args], {
    env: { ...env, TMPDIR: dir, TMP: dir, TEMP: dir },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  const closed = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let status: number | null = null;
  let failure: Error | undefined;
  try {
    status = await Promise.race([
      closed,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Fixture process timed out after ${timeout} ms\n${output}`)),
          timeout,
        );
      }),
    ]);
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
  } finally {
    clearTimeout(timer);
  }
  try {
    if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH')
      failure ??= error instanceof Error ? error : new Error(String(error));
  }
  await closed.catch((error: unknown) => {
    failure ??= error instanceof Error ? error : new Error(String(error));
  });
  if (failure !== undefined || status === null || status === 124) {
    removeFixture(dir);
    throw failure ?? new Error(`Fixture process failed or timed out (status ${status})\n${output}`);
  }
  return { status, output };
}

const subtreeModes = ['rm', 'rmdir', 'rename-source', 'rename-destination', 'cp'].flatMap((operation) =>
  ['sync', 'callback', 'promise'].map((form) => `${operation}-${form}`),
);
it.each([
  'worker',
  'worker-loop',
  'worker-promise',
  'worker-open-sync',
  'worker-open-callback',
  'worker-open-promise',
  'worker-readflag',
  'worker-alias',
  'child',
  'child-async',
  'thread-eval',
  'thread-file',
  'thread-shared-env',
  'foreign',
  ...subtreeModes,
])(
  'attributes %s writes without observing unrelated processes',
  async (mode) => {
    const dir = mkdtempSync(join(tmpdir(), 'coral-guard-fixture-'));
    fixtures.push(dir);
    const root = join(dir, 'real-home', '.coral');
    mkdirSync(root, { recursive: true });
    const target = mode === 'worker-loop' ? join(root, 'loop', 'offending') : join(root, 'offending');
    if (mode === 'worker-loop') symlinkSync('loop', join(root, 'loop'));
    const sentinel = join(root, 'sentinel');
    writeFileSync(sentinel, 'keep');
    const source = join(dir, 'copy-source');
    mkdirSync(join(source, '.coral'), { recursive: true });
    writeFileSync(join(source, '.coral', 'offending'), 'leak');
    const subdir = join(dir, 'real-home', 'subdir');
    mkdirSync(subdir);
    symlinkSync(subdir, join(dir, 'alias'));
    const subtree = subtreeModes.includes(mode);
    const offendingPath = subtree
      ? join(dir, 'real-home')
      : mode === 'worker-alias'
        ? `${dir}/alias/../.coral/offending`
        : target;
    const globalSetup = resolve('vitest/no-real-coral-leak.ts');
    writeFileSync(
      join(dir, 'global.ts'),
      `import setup from ${JSON.stringify(globalSetup)};
import {userInfo} from 'node:os';
import {join} from 'node:path';
export default function(project) {
 const teardown = setup(project);
 const config = JSON.parse(project.config.env.CORAL_TEST_WRITE_GUARD);
 if (config.root !== join(userInfo().homedir, '.coral')) throw new Error('Guard lost the OS account home');
 project.config.env.CORAL_TEST_WRITE_GUARD = JSON.stringify({...config, root: ${JSON.stringify(root)}});
 return teardown;
}`,
    );
    writeFileSync(
      join(dir, 'config.ts'),
      `export default { root: ${JSON.stringify(dir)}, test: {
 include: ['fixture.test.ts'],
 globalSetup: ['./global.ts', ${JSON.stringify(resolve('vitest/isolated-unit-home.ts'))}],
 setupFiles: [${JSON.stringify(resolve('vitest/setup.ts'))}],
 env: { CORAL_TEST_TIER: 'guard-fixture' },
 } };`,
    );
    const write = `require('node:fs').writeFileSync(${JSON.stringify(target)}, 'leak')`;
    writeFileSync(join(dir, 'thread.cjs'), write);
    let subtreeWrite = '';
    if (subtree) {
      const form = mode.slice(mode.lastIndexOf('-') + 1);
      const operation = mode.slice(0, mode.lastIndexOf('-'));
      const method = operation.startsWith('rename') ? 'rename' : operation;
      const args =
        operation === 'rename-source'
          ? [offendingPath, join(dir, 'moved-home')]
          : operation === 'rename-destination'
            ? [source, offendingPath]
            : operation === 'cp'
              ? [source, offendingPath, { recursive: true }]
              : operation === 'rm'
                ? [offendingPath, { recursive: true }]
                : [offendingPath];
      const argumentsText = args.map((arg) => JSON.stringify(arg)).join(', ');
      subtreeWrite =
        form === 'sync'
          ? `fs.${method}Sync(${argumentsText});`
          : form === 'promise'
            ? `await fs.promises.${method}(${argumentsText});`
            : `await new Promise((resolve, reject) => fs.${method}(${argumentsText}, error => error ? reject(error) : resolve()));`;
    }
    writeFileSync(
      join(dir, 'fixture.test.ts'),
      `import { it } from 'vitest';
import { writeFileSync, readFileSync, promises } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { Worker, SHARE_ENV } from 'node:worker_threads';
it('fixture write', async () => {
 ${subtree ? `try { ${subtreeWrite} } catch {}` : ''}
 ${
   mode.startsWith('thread-')
     ? `await new Promise(resolve => {
 const worker = new Worker(${JSON.stringify(mode === 'thread-file' ? join(dir, 'thread.cjs') : write)}, {
 eval: ${mode !== 'thread-file'}, execArgv: [], env: ${mode === 'thread-shared-env' ? 'SHARE_ENV' : '{}'}
 });
 worker.on('error', () => {}); worker.on('exit', resolve);
 });`
     : ''
 }
 ${mode === 'worker' || mode === 'worker-loop' ? `try { writeFileSync(${JSON.stringify(target)}, 'leak'); } catch {}` : ''}
 ${mode === 'worker-open-sync' ? `try { fs.openSync(${JSON.stringify(target)}, 'w'); } catch {}` : ''}
 ${mode === 'worker-open-callback' ? `try { await new Promise((resolve, reject) => fs.open(${JSON.stringify(target)}, 'w', error => error ? reject(error) : resolve())); } catch {}` : ''}
 ${mode === 'worker-open-promise' ? `try { await fs.promises.open(${JSON.stringify(target)}, 'w'); } catch {}` : ''}
 ${mode === 'worker-readflag' ? `try { readFileSync(${JSON.stringify(target)}, {encoding: 'utf8', flag: 'w'}); } catch {}` : ''}
 ${mode === 'worker-alias' ? `try { writeFileSync(${JSON.stringify(offendingPath)}, 'leak'); } catch {}` : ''}
 ${mode === 'worker-promise' ? `try { await promises.writeFile(${JSON.stringify(target)}, 'leak'); } catch {}` : ''}
 ${mode === 'child-async' ? `await new Promise((resolve, reject) => spawn(process.execPath, ['-e', ${JSON.stringify(write)}], {env: {HOME: process.env.HOME}, timeout: 4000, killSignal: 'SIGKILL'}).on('error', reject).on('close', (code, signal) => signal ? reject(new Error('Fixture subprocess timeout/failure')) : resolve(code)));` : ''}
 ${mode === 'child' ? `const child = spawnSync(process.execPath, ['-e', ${JSON.stringify(write)}], {env: {HOME: process.env.HOME}, timeout: 4000, killSignal: 'SIGKILL'}); if (child.error || child.signal) throw new Error('Fixture subprocess timeout/failure');` : ''}
});`,
    );
    // The foreign writer must originate outside the guarded process tree.
    if (mode === 'foreign') {
      writeFileSync(
        join(dir, 'fixture.test.ts'),
        `import {it} from 'vitest'; import {writeFileSync, existsSync} from 'node:fs';
it('foreign window', async () => {
 writeFileSync(${JSON.stringify(join(dir, 'ready'))}, 'ready');
 while (!existsSync(${JSON.stringify(target)})) await new Promise(r => setTimeout(r, 10));
});`,
      );
    }
    const env = { ...process.env };
    delete env.CORAL_TEST_WRITE_GUARD;
    delete env.NODE_OPTIONS;
    env.HOME = join(dir, 'runner-home');
    const driver = `const {spawn, spawnSync} = require('node:child_process');
${mode === 'foreign' ? `const foreign = spawn(process.execPath, ['-e', ${JSON.stringify(`const fs = require('node:fs'); const timer = setInterval(() => { if(fs.existsSync(${JSON.stringify(join(dir, 'ready'))})) { clearInterval(timer); ${write}; } }, 10); setTimeout(() => process.exit(1), 10000).unref();`)}], {env: {}});` : ''}
const result = spawnSync(process.execPath, ${JSON.stringify([resolve('node_modules/vitest/vitest.mjs'), 'run', '--config', join(dir, 'config.ts')])}, {env: process.env, encoding: 'utf8', timeout: 8000, killSignal: 'SIGKILL'});
process.stdout.write(result.stdout + result.stderr);
if (result.error || result.signal || result.status === null) {
 process.stderr.write('Fixture runner failed: ' + String(result.error ?? result.signal));
 process.exitCode = 124;
} else process.exitCode = result.status;`;
    const { status, output } = await runFixture(dir, ['-e', driver], env);
    expect(output).not.toContain('Fixture subprocess timeout/failure');
    if (mode === 'foreign') {
      expect(status, output).toBe(0);
      expect(readFileSync(target, 'utf8')).toBe('leak');
    } else {
      expect(status, output).not.toBe(0);
      expect(output).toContain('Tests attempted writes into the real ~/.coral tree');
      expect(output).toContain(`"path":${JSON.stringify(offendingPath)},`);
      expect(output).toContain('fixture.test.ts');
      expect(output).toContain('pid');
      expect(existsSync(target)).toBe(false);
      expect(readFileSync(sentinel, 'utf8')).toBe('keep');
      if (mode.startsWith('thread-')) expect(output).toMatch(/threadId[\\]?":\s*[1-9]/);
    }
  },
  15_000,
);

it.each(['children', 'filesystem', 'errors'])(
  'preserves allowed %s argument forms',
  async (mode) => {
    const dir = mkdtempSync(join(tmpdir(), 'coral-guard-allowed-'));
    fixtures.push(dir);
    const result = await runFixture(dir, [
      resolve('tests/fixtures/coral-write-guard-transparency.cjs'),
      mode,
      resolve('vitest/coral-write-guard.cjs'),
      dir,
    ]);
    expect(result.status, result.output).toBe(0);
    expect(result.output).toBe('transparent');
  },
  15_000,
);

it('reports a hung fixture, kills its descendants, and removes its directory', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coral-guard-timeout-'));
  fixtures.push(dir);
  const driver = `const {spawn} = require('node:child_process');
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio: 'ignore'});
console.log('owned:' + process.pid + ',' + child.pid);
setInterval(() => {}, 1000);`;
  const failure = await runFixture(dir, ['-e', driver], process.env, 500).then(
    () => {
      throw new Error('Hung fixture unexpectedly passed');
    },
    (error: unknown) => {
      if (!(error instanceof Error)) throw error;
      return error;
    },
  );
  expect(failure.message).toContain('Fixture process timed out after 500 ms');
  const owned = /owned:(\d+),(\d+)/.exec(failure.message);
  expect(owned).not.toBeNull();
  await vi.waitFor(
    () => {
      for (const pid of owned?.slice(1) ?? []) {
        expect(() => process.kill(Number(pid), 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
      }
    },
    { timeout: 2000, interval: 20 },
  );
  expect(existsSync(dir)).toBe(false);
});
