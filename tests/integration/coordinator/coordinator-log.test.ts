import { spawnSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseUpgradeIntentSnapshot } from '#src/infra/upgrade-intent.js';
import { upgradeIntentPath } from '#src/infra/path/coordinator.js';

function writeDeadlineIntent(runDir: string, flavor: 'prod' | 'dev'): void {
  const intent = parseUpgradeIntentSnapshot({
    version: 'v1',
    requestId: 'request-test',
    revision: 1,
    incumbent: {
      instanceId: 'incumbent-test',
      pid: 1,
      incarnation: null,
      version: '0.10.26',
      bundleHash: 'hash',
      flavor,
    },
    target: {
      pluginRootLabel: '/fixture',
      build: {
        version: '0.10.27',
        buildSetId: 'build-test',
        flavor,
        storeFormatFingerprint: 'fingerprint',
        bundleHash: 'hash',
        cliBundleHash: 'hash',
        claudeAppserverBundleHash: 'hash',
        durableWrapperBundleHash: 'hash',
      },
    },
    attemptId: 'attempt-test',
    attemptChild: null,
    attemptOwner: { kind: 'incumbent', instanceId: 'incumbent-test', pid: 1, incarnation: null },
    disposition: 'attempting',
    blockers: [],
    retryCondition: null,
    attemptDeadline: new Date(1793908800000).toISOString(),
    completionReceipt: null,
  });
  expect(intent).not.toBeNull();
  writeFileSync(upgradeIntentPath(runDir), JSON.stringify(intent));
}

const dir = mkdtempSync(join(tmpdir(), 'coral-coordinator-log-'));
const fixture = join(dir, 'bootstrap.cjs');

beforeAll(async () => {
  symlinkSync(resolve('node_modules'), join(dir, 'node_modules'));
  mkdirSync(join(dir, 'bridge'));
  writeFileSync(join(dir, 'bridge', 'manifest.json'), JSON.stringify({ flavor: 'dev' }));
  await build({
    stdin: {
      contents: `import { main } from '#src/coordinator/bootstrap.js'; main().then(code => process.exit(code));`,
      resolveDir: process.cwd(),
    },
    outfile: fixture,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    packages: 'external',
    loader: { '.sql': 'text' },
    define: {
      __PLUGIN_ROOT__: JSON.stringify(dir),
      __VERSION__: JSON.stringify('0.10.27'),
      'import.meta.url': JSON.stringify(pathToFileURL(fixture).href),
    },
    plugins: [
      {
        name: 'startup-failure',
        setup(plugin) {
          plugin.onResolve({ filter: /^#src\// }, (args) => ({
            path: resolve(args.path.replace('#src/', 'src/').replace(/\.js$/, '.ts')),
          }));
          plugin.onResolve({ filter: /index\.js|attempt-child\.js|real\.js/ }, (args) => {
            if (!args.importer.endsWith('/coordinator/bootstrap.ts')) return;
            return { path: args.path, namespace: 'startup-fixture' };
          });
          plugin.onLoad({ filter: /.*/, namespace: 'startup-fixture' }, (args) => ({
            contents: args.path.endsWith('index.js')
              ? `import { createCoordinatorServer as real } from '#src/coordinator/index.js'; export function createCoordinatorServer(options) { if (process.env.TEST_PHASE_FAILURE) return real({...options, listenIpcFn: async () => { throw new Error('diagnostic-regression'); }}); if (process.env.TEST_REAL_RUNTIME && options.runtime.env.fullSnapshot().CORAL_FAILURE_DOMAIN_REFUSALS !== undefined) throw new Error('consumed launch context captured'); throw new Error('diagnostic-regression'); }`
              : args.path.endsWith('real.js')
                ? `import { createRealRuntime as real } from '#src/runtime/real.js'; export function createRealRuntime(flavor) { return process.env.TEST_REAL_RUNTIME ? real(flavor) : { ids: { uuid: () => 'coordinator-instance-test' }, paths: { coral: { coordinator: { runDir: process.env.TEST_RUN_DIR } } } }; }`
                : `export async function receiveSuccessionAttemptChild() { return { deadline: process.env.TEST_CHILD_DEADLINE ? Number(process.env.TEST_CHILD_DEADLINE) : null, attemptId: 'attempt-test', bootToken: 'boot-test' }; } export function installSuccessionAttemptChild() {}`,
          }));
        },
      },
    ],
  });
});
beforeAll(async () => {
  await build({
    stdin: {
      contents: `import { installCoordinatorLog, withCoordinatorLog } from '#src/infra/coordinator-log.js';
        import { backendLog } from '#src/infra/backend-log.js';
        import { recordControllerEvidenceRefusals } from '#src/infra/launch-status.js';
        import { createStartupPhaseObserver, observeRecoveryPhase } from '#src/recovery/phase-observation.js';
        import { readFileSync, writeSync } from 'node:fs';
        function run() {
        if (process.env.TEST_LAUNCH) {
          withCoordinatorLog(process.env.TEST_RUN_DIR, fd => writeSync(fd, 'launch-diagnostic\\n'));
          return;
        }
        installCoordinatorLog(process.env.TEST_RUN_DIR);
        if (process.env.TEST_CONTROLLER_EVIDENCE) {
          recordControllerEvidenceRefusals(process.env.TEST_RUN_DIR, [{path: '/fixture/controller', observation: 'unreadable'}]);
          recordControllerEvidenceRefusals(process.env.TEST_RUN_DIR, []);
          return;
        }
        if (process.env.TEST_PIPE) {
          backendLog.raw('inherited-pipe-diagnostic\\n');
          return;
        }
        if (process.env.TEST_UNUSABLE) {
          backendLog.info('dropped-info');
          backendLog.warn('dropped-warn');
          backendLog.error('dropped-error');
          backendLog.raw('dropped-raw\\n');
          setTimeout(() => process.stdout.write('survived\\n'), 30);
          return;
        }
        if (process.env.TEST_INHERITED) {
          writeSync(3, 'sentinel-before-owned-write\\n');
          backendLog.raw('owned-above-threshold\\n');
          writeSync(3, 'sentinel-after-owned-write\\n');
          return;
        }
        if (process.env.TEST_WRITE_FAILURE) {
          const fs = require('node:fs');
          const write = fs.writeSync;
          let fail = true;
          fs.writeSync = (...args) => {
            if (fail) { fail = false; throw new Error('injected write failure'); }
            return write(...args);
          };
          backendLog.raw('failed-write\\n');
          backendLog.raw('after-write-failure\\n');
          return;
        }
        const boot = createStartupPhaseObserver({time: {monotonicNow: () => 0n}, log: backendLog.raw, bootId: 'stuck-boot'});
        void observeRecoveryPhase(boot.options('job-locations'), () => {
          process.stdout.write(readFileSync(process.env.TEST_RUN_DIR + '/coordinator.log', 'utf8'));
          return new Promise(() => {});
        });
        }
        run();`,
      resolveDir: process.cwd(),
    },
    outfile: join(dir, 'stuck.cjs'),
    alias: { '#src': resolve('src') },
    bundle: true,
    platform: 'node',
    format: 'cjs',
  });
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('coordinator-owned diagnostics', () => {
  it('keeps inherited writer lines readable above the launch rotation threshold', () => {
    const runDir = mkdtempSync(join(dir, 'inherited-'));
    const log = join(runDir, 'coordinator.log');
    writeFileSync(log, 'before-install\n' + 'x'.repeat(2 * 1024 * 1024));
    const sentinel = openSync(log, 'a');
    try {
      const result = spawnSync(process.execPath, [join(dir, 'stuck.cjs')], {
        env: { ...process.env, TEST_RUN_DIR: runDir, TEST_INHERITED: '1' },
        stdio: ['ignore', 'pipe', 'ignore', sentinel],
        timeout: 10_000,
      });
      expect(result.status).toBe(0);
      const lines = readFileSync(log, 'utf8');
      expect(lines).toContain('before-install\n');
      expect(lines).toContain('sentinel-before-owned-write\nowned-above-threshold\nsentinel-after-owned-write\n');
    } finally {
      closeSync(sentinel);
    }
  });
  it('contains a write failure and retains later diagnostics', () => {
    const runDir = mkdtempSync(join(dir, 'write-failure-'));
    const result = spawnSync(process.execPath, [join(dir, 'stuck.cjs')], {
      env: { ...process.env, TEST_RUN_DIR: runDir, TEST_WRITE_FAILURE: '1' },
      stdio: 'ignore',
      timeout: 10_000,
    });
    expect(result.status).toBe(0);
    expect(readFileSync(join(runDir, 'coordinator.log'), 'utf8')).toBe('after-write-failure\n');
  });
  it('retains launch-status refusal and recovery diagnostics with null stderr', () => {
    const runDir = mkdtempSync(join(dir, 'controller-evidence-'));
    const result = spawnSync(process.execPath, [join(dir, 'stuck.cjs')], {
      env: { ...process.env, TEST_RUN_DIR: runDir, TEST_CONTROLLER_EVIDENCE: '1' },
      stdio: 'ignore',
      timeout: 10_000,
    });
    expect(result.status).toBe(0);
    const log = readFileSync(join(runDir, 'coordinator.log'), 'utf8');
    expect(log).toContain('Controller evidence refused path=/fixture/controller observation=unreadable\n');
    expect(log).toContain('Controller evidence readable or absent path=/fixture/controller\n');
  });
  it('retains writable inherited pipe diagnostics without creating an owned log', () => {
    const runDir = mkdtempSync(join(dir, 'pipe-'));
    const result = spawnSync(process.execPath, [join(dir, 'stuck.cjs')], {
      env: { ...process.env, TEST_RUN_DIR: runDir, TEST_PIPE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
    });
    expect(result.status).toBe(0);
    expect(result.stderr.toString()).toBe('inherited-pipe-diagnostic\n');
    expect(existsSync(join(runDir, 'coordinator.log'))).toBe(false);
  });
  it('survives readonly stderr and an obstructed log directory', () => {
    const runDir = join(dir, 'obstructed-run');
    writeFileSync(runDir, 'not a directory');
    const stderr = openSync(fixture, 'r');
    try {
      const result = spawnSync(process.execPath, [join(dir, 'stuck.cjs')], {
        env: { ...process.env, TEST_RUN_DIR: runDir, TEST_UNUSABLE: '1' },
        stdio: ['ignore', 'pipe', stderr],
        timeout: 10_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stdout.toString()).toBe('survived\n');
    } finally {
      closeSync(stderr);
    }
  });
  it('uses the dev bundle runtime for both the sink and failure intent with CORAL_FLAVOR unset', () => {
    const home = mkdtempSync(join(dir, 'dev-home-'));
    const runDir = join(home, '.coral', 'gen2', 'run-dev');
    mkdirSync(runDir, { recursive: true });
    writeDeadlineIntent(runDir, 'dev');
    const result = spawnSync(process.execPath, [fixture], {
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        TEST_REAL_RUNTIME: '1',
        CORAL_FAILURE_DOMAIN_REFUSALS: '[]',
        CORAL_FLAVOR: undefined,
        CORAL_SENTINEL_ID: undefined,
      },
      stdio: 'ignore',
      timeout: 10_000,
    });
    expect(result.status).toBe(1);
    expect(readFileSync(join(runDir, 'coordinator.log'), 'utf8')).toContain(
      'deadline=1793908800000 error=Error: diagnostic-regression',
    );
    expect(() => readFileSync(join(home, '.coral', 'gen2', 'run', 'coordinator.log'))).toThrow();
  });
  it('correlates a real startup phase and succession failure by boot identity', () => {
    const home = mkdtempSync(join(dir, 'phase-failure-home-'));
    const result = spawnSync(process.execPath, [fixture], {
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        TEST_REAL_RUNTIME: '1',
        TEST_PHASE_FAILURE: '1',
        CORAL_KB_ENABLE: '0',
        CORAL_SENTINEL_ID: undefined,
        CORAL_FLAVOR: undefined,
      },
      stdio: 'ignore',
      timeout: 10_000,
    });
    expect(result.status).toBe(1);
    const log = readFileSync(join(home, '.coral', 'gen2', 'run-dev', 'coordinator.log'), 'utf8');
    const phaseBoot = /recovery-phase boot=(\S+) kind=startup phase=boot event=start/.exec(log)?.[1];
    const failureBoot = /recovery-phase boot=(\S+) kind=startup phase=succession event=finish outcome=failed/.exec(
      log,
    )?.[1];
    expect(phaseBoot, log).toBeDefined();
    expect(failureBoot, log).toBe(phaseBoot);
    expect(log).toContain('attempt=attempt-test attempt_token=boot-test');
    expect(log).toContain('error=Error: diagnostic-regression');
  });
  it('preserves inherited stderr when the log path cannot be opened', () => {
    const runDir = mkdtempSync(join(dir, 'launcher-fallback-'));
    mkdirSync(join(runDir, 'coordinator.log'));
    const result = spawnSync(process.execPath, [join(dir, 'stuck.cjs')], {
      env: { ...process.env, TEST_RUN_DIR: runDir, TEST_LAUNCH: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
    });
    expect(result.status).toBe(0);
    expect(result.stderr.toString()).toBe('launch-diagnostic\n');
    expect(result.stdout.toString()).toBe('');
  });
  it('rotates an oversized log at launch', () => {
    const runDir = mkdtempSync(join(dir, 'launch-'));
    const log = join(runDir, 'coordinator.log');
    const previous = 'before-launch\n' + 'x'.repeat(2 * 1024 * 1024);
    writeFileSync(log, previous);
    const result = spawnSync(process.execPath, [join(dir, 'stuck.cjs')], {
      env: { ...process.env, TEST_RUN_DIR: runDir, TEST_LAUNCH: '1' },
      stdio: 'ignore',
      timeout: 10_000,
    });
    expect(result.status).toBe(0);
    expect(readFileSync(log, 'utf8')).toBe('launch-diagnostic\n');
    expect(readFileSync(`${log}.1`, 'utf8')).toBe(previous);
  });
  it('records START before entering a phase that never finishes', () => {
    const runDir = mkdtempSync(join(dir, 'stuck-'));
    const result = spawnSync(process.execPath, [join(dir, 'stuck.cjs')], {
      env: { ...process.env, TEST_RUN_DIR: runDir },
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
    });
    expect(result.status).toBe(0);
    expect(result.stdout.toString()).toContain(
      'recovery-phase boot=stuck-boot kind=startup phase=job-locations event=start',
    );
    expect(readFileSync(join(runDir, 'coordinator.log'), 'utf8')).not.toContain('event=finish');
  });
  it.each(['null', 'log', 'readonly', 'received'] as const)(
    'retains a startup failure exactly once with stderr=%s',
    (destination) => {
      const runDir = mkdtempSync(join(dir, 'run-'));
      const logPath = join(runDir, 'coordinator.log');
      if (destination === 'null' || destination === 'readonly') writeDeadlineIntent(runDir, 'prod');
      const fd = openSync(
        destination === 'null' || destination === 'received'
          ? '/dev/null'
          : destination === 'readonly'
            ? fixture
            : logPath,
        destination === 'readonly' ? 'r' : 'a',
      );
      try {
        const result = spawnSync(process.execPath, [fixture], {
          env: {
            ...process.env,
            TEST_RUN_DIR: runDir,
            TEST_CHILD_DEADLINE: destination === 'received' ? '1793908800000' : undefined,
            CORAL_SENTINEL_ID: undefined,
          },
          stdio: ['ignore', 'pipe', fd],
          timeout: 10_000,
        });
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(1);
        const log = readFileSync(logPath, 'utf8');
        expect(log.match(/event=finish outcome=failed/g)).toHaveLength(1);
        expect(log).toContain('attempt=attempt-test attempt_token=boot-test version=0.10.27 pid=');
        expect(log).toContain(
          `deadline=${destination === 'log' ? 'unknown' : '1793908800000'} error=Error: diagnostic-regression\n    at`,
        );
      } finally {
        closeSync(fd);
      }
    },
  );
});
