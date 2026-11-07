import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  utimesSync,
  unlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { LOG_ROTATE_THRESHOLD_BYTES, withCoordinatorLog } from '#src/infra/coordinator-log.js';
import { parseUpgradeIntentSnapshot } from '#src/infra/upgrade-intent.js';
import { upgradeIntentPath } from '#src/infra/path/coordinator.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';
import {
  parseLinuxProcessIncarnation,
  probeProcessIncarnation,
  processIncarnationStartOrder,
} from '#src/infra/node-process.js';

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

function latestPath(runDir: string, pointer = 'latest-coordinator.json'): string {
  return (JSON.parse(readFileSync(join(runDir, 'coordinator-logs', pointer), 'utf8')) as { path: string }).path;
}

function writerMessage(child: ChildProcess): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const signal = AbortSignal.timeout(10_000);
    const cleanup = (): void => {
      child.off('message', message);
      child.off('exit', exited);
      child.off('error', failed);
      signal.removeEventListener('abort', aborted);
    };
    const message = (value: unknown): void => {
      cleanup();
      resolve(value);
    };
    const failed = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const exited = (): void => failed(new Error('Fixture writer exited before reporting'));
    const aborted = (): void => failed(signal.reason as Error);
    child.once('message', message);
    child.once('exit', exited);
    child.once('error', failed);
    signal.addEventListener('abort', aborted, { once: true });
  });
}

async function fixtureExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await once(child, 'exit', { signal: AbortSignal.timeout(10_000) });
}

async function stopFixture(child: ChildProcess): Promise<void> {
  if (child.connected) child.disconnect();
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = fixtureExit(child);
  child.kill('SIGKILL');
  await exited;
}

function latestLog(runDir: string): string {
  return readFileSync(latestPath(runDir), 'utf8');
}

function recordedWriter(
  runDir: string,
  role: 'coordinator' | 'supervisor',
  age: number,
  incarnation = testIncarnation('stale-writer'),
): string {
  const directory = join(runDir, 'coordinator-logs', randomUUID());
  mkdirSync(directory, { recursive: true });
  const record = join(directory, 'writer.json');
  writeFileSync(
    record,
    JSON.stringify({
      version: 1,
      role,
      pid: 2147483000,
      incarnation,
    }),
  );
  writeFileSync(join(directory, 'current.log'), 'uncertified diagnostics');
  utimesSync(record, age, age);
  return directory;
}

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
                ? `import { createRealRuntime as real } from '#src/runtime/real.js'; export function createRealRuntime(flavor) { const runtime = real(flavor); if (process.env.TEST_BOOT_POINTER_ONCE) { let failed = false; const rename = runtime.storage.renameSync; return {...runtime, storage: {...runtime.storage, renameSync(from, to) { if (!failed && String(to).endsWith('/latest-coordinator.json')) { failed = true; throw Object.assign(new Error('pointer-publication-unavailable'), {code:'EIO'}); } return rename(from, to); }}}; } if (process.env.TEST_REAL_RUNTIME) return runtime; return {...runtime, paths: {...runtime.paths, coral: {...runtime.paths.coral, coordinator: {...runtime.paths.coral.coordinator, runDir: process.env.TEST_RUN_DIR}}}}; }`
                : `export async function receiveSuccessionAttemptChild() { return process.env.TEST_NO_SUCCESSION ? null : { deadline: process.env.TEST_CHILD_DEADLINE ? Number(process.env.TEST_CHILD_DEADLINE) : null, attemptId: 'attempt-test', bootToken: 'boot-test' }; } export function installSuccessionAttemptChild() {}`,
          }));
        },
      },
    ],
  });
});
beforeAll(async () => {
  await build({
    stdin: {
      contents: `import { getCoordinatorLogPath, installCoordinatorLog, withCoordinatorLog } from '#src/infra/coordinator-log.js';
        import { backendLog } from '#src/infra/backend-log.js';
        import { createCoordinatorHealthReader } from '#src/coordinator/composition/health-observation.js';
        import { recordControllerEvidenceRefusals } from '#src/infra/launch-status.js';
        import { createStartupPhaseObserver, observeRecoveryPhase } from '#src/recovery/phase-observation.js';
        import { readFileSync, writeSync } from 'node:fs';
        import { spawn } from 'node:child_process';
        import { probeProcessIncarnation as requireIncarnation } from '#src/infra/node-process.js';
        function run() {
        if (process.env.TEST_LAUNCH) {
          withCoordinatorLog(process.env.TEST_RUN_DIR, stderr => spawn(process.execPath, ['-e', "process.stderr.write('launch-diagnostic\\\\n')"], {stdio: ['ignore', 'ignore', stderr],timeout:5_000,killSignal:'SIGKILL'}));
          return;
        }
        let installFailureInjected = false;
        if (process.env.TEST_INSTALL_FAULT) {
          const fs = require('node:fs');
          const fault = process.env.TEST_INSTALL_FAULT;
          const method = {mkdir:'mkdirSync',record:'writeFileSync',rename:'renameSync',open:'openSync'}[fault];
          const original = fs[method];
          fs[method] = (path, ...args) => {
            const matches = fault === 'mkdir' ? path.endsWith('/coordinator-logs')
              : fault === 'record' ? path.endsWith('/writer.json')
              : fault === 'rename' ? path.includes('/.stage-')
              : path.endsWith('/current.log');
            if (!installFailureInjected && matches) {
              installFailureInjected = true;
              throw Object.assign(new Error('writer-install-unavailable'), {code:'EIO'});
            }
            return original(path, ...args);
          };
        }
        if (process.env.TEST_RECORD_FAILURE) {
          const fs = require('node:fs');
          const write = fs.writeFileSync;
          fs.writeFileSync = (path, ...args) => {
            if (path.endsWith('/writer.json')) throw new Error('writer-record-unavailable');
            return write(path, ...args);
          };
        }
        if (process.env.TEST_POINTER_FAILURE) {
          const fs = require('node:fs');
          const rename = fs.renameSync;
          fs.renameSync = (from, to) => {
            if (to.endsWith('/latest-coordinator.json')) throw new Error('pointer-publication-unavailable');
            return rename(from, to);
          };
        }
        let pointerAttempts = 0;
        if (process.env.TEST_POINTER_ONCE) {
          const fs = require('node:fs');
          const rename = fs.renameSync;
          fs.renameSync = (from, to) => {
            if (to.endsWith('/latest-coordinator.json') && ++pointerAttempts === 1) {
              throw Object.assign(new Error('pointer-publication-unavailable'), {code:'EIO'});
            }
            return rename(from, to);
          };
        }
        let retentionPass;
        let observation = process.env.TEST_OBSERVATION;
        const ports = process.env.TEST_RETENTION || process.env.TEST_POINTER_ONCE ? {
          storage: require('node:fs'),
          ids: {uuid: require('node:crypto').randomUUID},
          env: {pid: () => process.pid, platform: () => process.platform},
          process: {
            readProcessIncarnation: pid => pid === process.pid ? requireIncarnation(pid) : observation === 'alive' ? 'linux:00000000-0000-4000-8000-000000000000:stale-writer' : observation === 'reused' ? 'linux:00000000-0000-4000-8000-000000000000:reused-writer' : null,
            observeLiveness: pid => {
              if (process.env.TEST_POINTER_TARGET && pid !== process.pid && observation === 'absent') {
                require('node:fs').writeFileSync(process.env.TEST_RUN_DIR + '/coordinator-logs/latest-coordinator.json', JSON.stringify({path:process.env.TEST_POINTER_TARGET,writer:{version:1,role:'coordinator',pid,incarnation:'linux:00000000-0000-4000-8000-000000000000:stale-writer'}}));
              }
              return observation === 'absent' ? 'absent' : observation === 'alive' || observation === 'reused' ? 'alive' : 'unknown';
            },
          },
          time: {
            setInterval: callback => {retentionPass = callback; return {unref() {}};},
            clearInterval() {},
          },
        } : undefined;
        installCoordinatorLog(process.env.TEST_RUN_DIR, ports, process.env.TEST_ROLE ?? 'coordinator');
        if (process.env.TEST_INSTALL_FAULT) {
          backendLog.raw('after-install-failure\\n');
          backendLog.raw('later-install-diagnostic\\n');
          process.stdout.write(JSON.stringify({injected:installFailureInjected,path:getCoordinatorLogPath() ?? null}));
          return;
        }
        if (process.env.TEST_POINTER_ONCE) {
          const fs = require('node:fs');
          const path = getCoordinatorLogPath();
          backendLog.raw('after-publication-failure\\n');
          retentionPass();
          retentionPass();
          const health = createCoordinatorHealthReader({
            runtime: {
              storage: fs, paths: {coral:{coordinator:{runDir:process.env.TEST_RUN_DIR}}},
              env: {get:() => undefined, platform:() => process.platform},
              process: {readHostPressure:() => ({kind:'unobservable',reason:'fixture'}),failureDomainRoot:null,readRecentFailureDomainRefusals:() => []},
            },
            world: {
              identity: {version:'test',bundleHash:'test',flavor:'dev',namespace:'test',instanceId:'test',now:() => 0},
              backendPid: process.pid, coralEnvSnapshot: {}, storeServicesRef: {tryGet:() => null},
              idleTimer: {isDraining:false,inflightRequests:0}, providerProxyLifecycleRef: {get:() => null},
              discussRegistry: {contexts:new Map()},
              launchCoordinator: {active:0,queueDepth:() => 0,activeLaunchPermits:() => [],launchReleaseDiagnostics:() => [],launchReclamationDiagnostics:() => []},
            },
            options: {}, runtimeState: {getLifecycle:() => 'starting',getStartedAt:() => 0,components:{list:() => []}},
            lifecycleController:() => null,strictHealthIdentity:{ok:false},strictHealthBundleDir:null,readSelfIncarnation:() => null,
            kbDaemonSupervisor:{read:() => ({status:'offline'})},settlementRefusalRecordingFailures:new Map(),providerOperationAdoptionRefusals:new Map(),
            readIpcOpenSockets:() => 0,eventStreamResponseCount:() => 0,launchPermitReportAgeMs:0,providerOperationStartupStatus:() => null,
          })();
          process.stdout.write(JSON.stringify({attempts:pointerAttempts,path,healthPath:health.diagnostics.coordinatorLogPath,text:fs.readFileSync(path,'utf8')}));
          return;
        }
        if (process.env.TEST_RETENTION) {
          process.on('message', next => {
            observation = next;
            retentionPass();
            process.send('retention-finished');
          });
          process.on('disconnect', () => process.exit(0));
          process.send({path:getCoordinatorLogPath()});
          return;
        }
        if (process.env.TEST_RECORD_FAILURE || process.env.TEST_POINTER_FAILURE) return;
        if (process.env.TEST_GETTER) {
          const role = process.env.TEST_ROLE ?? 'coordinator';
          const ownPath = JSON.parse(readFileSync(process.env.TEST_RUN_DIR + '/coordinator-logs/latest-' + role + '.json', 'utf8')).path;
          process.stdout.write(JSON.stringify({actual:getCoordinatorLogPath() ?? null,ownPath}));
          return;
        }
        if (process.env.TEST_ROTATION_FAILURE) {
          const fs = require('node:fs');
          const path = getCoordinatorLogPath();
          backendLog.raw('x'.repeat(2 * 1024 * 1024));
          const rename = fs.renameSync;
          const open = fs.openSync;
          let failed = false;
          const held = [];
          fs.renameSync = (from, to) => {
            if (from === path) {
              if (process.platform === 'linux') {
                const source = fs.statSync(from);
                held.push(fs.readdirSync('/proc/self/fd').filter(name=>{try{const current=fs.fstatSync(Number(name));return current.ino===source.ino&&current.dev===source.dev;}catch{return false;}}));
              }
              if (process.env.TEST_ROTATION_FAILURE === 'rename' && !failed) {failed=true;throw new Error('transient-rename-failure');}
            }
            return rename(from, to);
          };
          fs.openSync = (target, flags, ...args) => {
            if (target === path && flags === 'wx' && process.env.TEST_ROTATION_FAILURE === 'open' && !failed) {failed=true;throw new Error('transient-open-failure');}
            return open(target, flags, ...args);
          };
          backendLog.raw('lost-once\\n');
          fs.openSync = open;
          backendLog.raw('recovered-after-rotation-failure\\n');
          fs.renameSync = rename;
          process.stdout.write(JSON.stringify({path,failed,held}));
          return;
        }
        if (process.env.TEST_FAILED_EXIT) {
          backendLog.raw('failed-writer-diagnostic\\n');
          process.exit(1);
        }
        if (process.env.TEST_UNCERTIFIED_EXIT) {
          backendLog.raw('uncertified-writer\\n');
          process.removeAllListeners('exit');
          process.exit(0);
        }
        if (process.env.TEST_LAUNCHED_CHILD_FDS) {
          const fs = require('node:fs');
          const path = getCoordinatorLogPath();
          const stat = fs.statSync(path);
          const child = withCoordinatorLog(process.env.TEST_RUN_DIR, stderr =>
            require('node:child_process').spawnSync(process.execPath, ['-e', \`
              const fs=require('node:fs');
              const open=fs.readdirSync('/proc/self/fd').filter(name=>{try{const stat=fs.fstatSync(Number(name));return String(stat.dev)===process.argv[1]&&String(stat.ino)===process.argv[2];}catch{return false;}});
              process.stderr.write('launched-child-native');
              process.stdout.write(JSON.stringify(open));
            \`, String(stat.dev), String(stat.ino)], {stdio:['ignore','pipe',stderr],timeout:5_000,killSignal:'SIGKILL'})
          );
          backendLog.raw('parent-private-diagnostic');
          process.stdout.write(JSON.stringify({status:child.status,held:JSON.parse(child.stdout.toString()),path}));
          return;
        }
        if (process.env.TEST_ROTATION_PROOF) {
          const fs = require('node:fs');
          const rename = fs.renameSync;
          fs.renameSync = (from, to) => {
            if (from.endsWith('/current.log')) {
              const source = fs.statSync(from);
              const open = process.platform === 'linux' ? fs.readdirSync('/proc/self/fd').flatMap(name => {
                try { const stat = fs.fstatSync(Number(name)); return stat.ino === source.ino && stat.dev === source.dev ? [Number(name)] : []; } catch { return []; }
              }) : null;
              process.stdout.write(JSON.stringify(open));
            }
            rename(from, to);
          };
          backendLog.raw('x'.repeat(2 * 1024 * 1024 + 1));
          return;
        }
        if (process.env.TEST_CLOSE_FAILURE) {
          const fs = require('node:fs');
          const write = fs.writeFileSync;
          fs.writeFileSync = (path, ...args) => {
            if (path.endsWith('/segments-closed')) throw new Error('closure-certificate-unavailable');
            return write(path, ...args);
          };
          backendLog.raw('retained-without-certificate');
          return;
        }
        if (process.env.TEST_PIPE_FAILURE) {
          process.once('message', () => {
            backendLog.raw('reader-already-exited');
            process.stdout.write('survived', () => process.exit(0));
          });
          process.send('ready');
          return;
        }
        if (process.env.TEST_SERVING) {
          const fs = require('node:fs');
          const path = JSON.parse(fs.readFileSync(process.env.TEST_RUN_DIR + '/coordinator-logs/latest-coordinator.json', 'utf8')).path;
          backendLog.raw('writer-ready\\n');
          process.on('message', message => {
            backendLog.raw(message === 'volume' ? 'x'.repeat(2 * 1024 * 1024 * 3) + 'tail-marker\\n' : 'still-owned\\n');
            const current = fs.statSync(path);
            const held = process.platform === 'linux' ? fs.readdirSync('/proc/self/fd').filter(name => {try {const value=fs.fstatSync(Number(name));return value.ino===current.ino && value.dev===current.dev;}catch{return false;}}) : null;
            process.send({path, inode: current.ino, held: held === null ? null : held.length});
          });
          process.on('disconnect', () => process.exit(0));
          process.send({path});
          return;
        }
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
          process.stdout.write(readFileSync(JSON.parse(readFileSync(process.env.TEST_RUN_DIR + '/coordinator-logs/latest-coordinator.json', 'utf8')).path, 'utf8'));
          return new Promise(() => {});
        });
        }
        run();`,
      resolveDir: process.cwd(),
    },
    outfile: join(dir, 'stuck.cjs'),
    loader: { '.sql': 'text' },
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
        killSignal: 'SIGKILL',
      });
      expect(result.status).toBe(0);
      const lines = readFileSync(log, 'utf8');
      expect(lines).toContain('before-install\n');
      expect(lines).toContain('sentinel-before-owned-write\nsentinel-after-owned-write\n');
      expect(latestLog(runDir)).toBe('owned-above-threshold\n');
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
      killSignal: 'SIGKILL',
    });
    expect(result.status).toBe(0);
    expect(latestLog(runDir)).toBe('after-write-failure\n');
  });
  it('retains launch-status refusal and recovery diagnostics with null stderr', () => {
    const runDir = mkdtempSync(join(dir, 'controller-evidence-'));
    const result = spawnSync(process.execPath, [join(dir, 'stuck.cjs')], {
      env: { ...process.env, TEST_RUN_DIR: runDir, TEST_CONTROLLER_EVIDENCE: '1' },
      stdio: 'ignore',
      timeout: 10_000,
      killSignal: 'SIGKILL',
    });
    expect(result.status).toBe(0);
    const log = latestLog(runDir);
    expect(log).toContain('Controller evidence refused path=/fixture/controller observation=unreadable\n');
    expect(log).toContain('Controller evidence readable or absent path=/fixture/controller\n');
  });
  it('owns diagnostics independently of a writable inherited pipe', () => {
    const runDir = mkdtempSync(join(dir, 'pipe-'));
    const result = spawnSync(process.execPath, [join(dir, 'stuck.cjs')], {
      env: { ...process.env, TEST_RUN_DIR: runDir, TEST_PIPE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
      killSignal: 'SIGKILL',
    });
    expect(result.status).toBe(0);
    expect(result.stderr.toString()).toBe('');
    expect(latestLog(runDir)).toBe('inherited-pipe-diagnostic\n');
    expect(existsSync(join(runDir, 'coordinator.log'))).toBe(false);
  });
  it.each(['mkdir', 'record', 'rename', 'open'])(
    'falls back to inherited fd 2 after a one-shot %s installation fault',
    (fault) => {
      const runDir = mkdtempSync(join(dir, 'install-failure-'));
      const result = withCoordinatorLog(runDir, (stderr) =>
        spawnSync(process.execPath, [join(dir, 'stuck.cjs')], {
          env: { ...process.env, TEST_RUN_DIR: runDir, TEST_INSTALL_FAULT: fault },
          stdio: ['ignore', 'pipe', stderr],
          timeout: 10_000,
          killSignal: 'SIGKILL',
        }),
      );
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout.toString())).toEqual({ injected: true, path: null });
      expect(readFileSync(join(runDir, 'coordinator-logs/native-stderr.log'), 'utf8')).toBe(
        'after-install-failure\n' + 'later-install-diagnostic\n',
      );
    },
  );
  it('survives readonly stderr and an obstructed log directory', () => {
    const runDir = join(dir, 'obstructed-run');
    writeFileSync(runDir, 'not a directory');
    const stderr = openSync(fixture, 'r');
    try {
      const result = spawnSync(process.execPath, [join(dir, 'stuck.cjs')], {
        env: { ...process.env, TEST_RUN_DIR: runDir, TEST_UNUSABLE: '1' },
        stdio: ['ignore', 'pipe', stderr],
        timeout: 10_000,
        killSignal: 'SIGKILL',
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
      killSignal: 'SIGKILL',
    });
    expect(result.status).toBe(1);
    expect(latestLog(runDir)).toContain('deadline=1793908800000 error=Error: diagnostic-regression');
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
      killSignal: 'SIGKILL',
    });
    expect(result.status).toBe(1);
    const log = latestLog(join(home, '.coral', 'gen2', 'run-dev'));
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
    writeFileSync(join(runDir, 'coordinator-logs'), 'obstructed');
    const result = spawnSync(process.execPath, [join(dir, 'stuck.cjs')], {
      env: { ...process.env, TEST_RUN_DIR: runDir, TEST_LAUNCH: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
      killSignal: 'SIGKILL',
    });
    expect(result.status).toBe(0);
    expect(result.stderr.toString()).toBe('launch-diagnostic\n');
    expect(result.stdout.toString()).toBe('');
  });
  it('preserves oversized legacy logs and points to the new bounded sink', async () => {
    const runDir = mkdtempSync(join(dir, 'launch-'));
    const log = join(runDir, 'coordinator.log');
    const previous = 'before-launch\n' + 'x'.repeat(2 * 1024 * 1024);
    writeFileSync(log, previous);
    const result = spawnSync(process.execPath, [join(dir, 'stuck.cjs')], {
      env: { ...process.env, TEST_RUN_DIR: runDir, TEST_LAUNCH: '1' },
      stdio: 'ignore',
      timeout: 10_000,
      killSignal: 'SIGKILL',
    });
    expect(result.status).toBe(0);
    expect(readFileSync(log, 'utf8')).toContain(previous);
    expect(readFileSync(join(runDir, 'coordinator-logs/native-stderr.log'), 'utf8')).toBe('launch-diagnostic\n');
    expect(existsSync(`${log}.1`)).toBe(false);
  });
  it('records START before entering a phase that never finishes', () => {
    const runDir = mkdtempSync(join(dir, 'stuck-'));
    const result = spawnSync(process.execPath, [join(dir, 'stuck.cjs')], {
      env: { ...process.env, TEST_RUN_DIR: runDir },
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
      killSignal: 'SIGKILL',
    });
    expect(result.status).toBe(0);
    expect(result.stdout.toString()).toContain(
      'recovery-phase boot=stuck-boot kind=startup phase=job-locations event=start',
    );
    expect(latestLog(runDir)).not.toContain('event=finish');
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
          killSignal: 'SIGKILL',
        });
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(1);
        const log = latestLog(runDir);
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

describe('in-process writer ownership', () => {
  it('keeps a mixed-build legacy descriptor intact across rotation, certification and pruning', async () => {
    const runDir = mkdtempSync(join(dir, 'live-legacy-'));
    const legacy = join(runDir, 'coordinator.log');
    const legacyArchive = `${legacy}.1`;
    const owner = withCoordinatorLog(runDir, (stderr) =>
      spawn(process.execPath, [join(dir, 'stuck.cjs')], {
        env: { ...process.env, TEST_RUN_DIR: runDir, TEST_SERVING: '1' },
        stdio: ['ignore', 'ignore', stderr, 'ipc'],
      }),
    );
    let holder: ChildProcess | null = null;
    let fd: number | null = null;
    try {
      const ready = await writerMessage(owner);
      const ownedSegment = (ready as { path: string }).path;
      fd = openSync(legacy, 'a');
      const inode = fstatSync(fd).ino;
      writeFileSync(legacyArchive, 'older-live-diagnostics');
      holder = spawn(
        process.execPath,
        [
          '-e',
          `
      process.on('message', message => process.stderr.write(message + '\\n', () => process.send('written')));
      process.on('disconnect', () => process.exit(0));
    `,
        ],
        { stdio: ['ignore', 'ignore', fd, 'ipc'] },
      );
      closeSync(fd);
      fd = null;
      expect(inode).not.toBe(statSync(ownedSegment).ino);
      owner.send('volume');
      await writerMessage(owner);
      owner.disconnect();
      await fixtureExit(owner);
      expect(existsSync(join(dirname(ownedSegment), 'segments-closed'))).toBe(true);
      for (let i = 0; i < 8; i++) {
        const result = spawnSync(process.execPath, [join(dir, 'stuck.cjs')], {
          env: { ...process.env, TEST_RUN_DIR: runDir, TEST_ROTATION_PROOF: '1' },
          stdio: ['ignore', 'pipe', 'ignore'],
          timeout: 10_000,
          killSignal: 'SIGKILL',
        });
        expect(result.status).toBe(0);
        if (process.platform === 'linux') expect(JSON.parse(result.stdout.toString())).toEqual([]);
        expect(existsSync(join(dirname(latestPath(runDir)), 'segments-closed'))).toBe(true);
      }
      expect(existsSync(ownedSegment)).toBe(false);
      holder.send('after-certification-and-pruning');
      await writerMessage(holder);
      expect(statSync(legacy).ino).toBe(inode);
      expect(lstatSync(legacy).isSymbolicLink()).toBe(false);
      expect(readFileSync(legacy, 'utf8')).toContain('after-certification-and-pruning');
      expect(readFileSync(legacyArchive, 'utf8')).toBe('older-live-diagnostics');
    } finally {
      await Promise.all([stopFixture(owner), holder === null ? Promise.resolve() : stopFixture(holder)]);
      if (fd !== null) closeSync(fd);
    }
  });

  it('keeps a real writer alive across multiple rotations and concurrent launches', async () => {
    const runDir = mkdtempSync(join(dir, 'live-writer-'));
    const holder = withCoordinatorLog(runDir, (stderr) =>
      spawn(process.execPath, [join(dir, 'stuck.cjs')], {
        env: { ...process.env, TEST_RUN_DIR: runDir, TEST_SERVING: '1' },
        stdio: ['ignore', 'ignore', stderr, 'ipc'],
      }),
    );
    try {
      const ready = await writerMessage(holder);
      const ownPath = (ready as { path: string }).path;
      holder.send('volume');
      const rotated = await writerMessage(holder);
      expect(rotated).toMatchObject({ path: ownPath });
      if (process.platform === 'linux') expect(rotated).toMatchObject({ held: 1 });
      expect(readFileSync(ownPath, 'utf8')).toContain('tail-marker');
      const inode = statSync(ownPath).ino;
      for (let i = 0; i < 8; i++) {
        const child = withCoordinatorLog(runDir, (stderr) =>
          spawn(process.execPath, [join(dir, 'stuck.cjs')], {
            env: { ...process.env, TEST_RUN_DIR: runDir, TEST_PIPE: '1' },
            stdio: ['ignore', 'ignore', stderr],
          }),
        );
        try {
          await fixtureExit(child);
        } finally {
          await stopFixture(child);
        }
      }
      expect(statSync(ownPath).ino).toBe(inode);
      holder.send('after-launches');
      const written = await writerMessage(holder);
      expect(written).toMatchObject({ path: ownPath, inode });
      if (process.platform === 'linux') expect(written).toMatchObject({ held: 1 });
      expect(readFileSync(ownPath, 'utf8')).toContain('still-owned');
      expect(statSync(ownPath).size).toBeLessThanOrEqual(LOG_ROTATE_THRESHOLD_BYTES);
      expect(statSync(`${ownPath}.1`).size).toBeLessThanOrEqual(LOG_ROTATE_THRESHOLD_BYTES);
      holder.disconnect();
      await fixtureExit(holder);
      expect(existsSync(dirname(ownPath))).toBe(false);
    } finally {
      await stopFixture(holder);
    }
  });

  it('retires certified segments while reusing one native stderr file', () => {
    const runDir = mkdtempSync(join(dir, 'closed-writers-'));
    for (let i = 0; i < 8; i++) {
      const child = withCoordinatorLog(runDir, (stderr) =>
        spawnSync(process.execPath, [join(dir, 'stuck.cjs')], {
          env: { ...process.env, TEST_RUN_DIR: runDir, TEST_PIPE: '1' },
          stdio: ['ignore', 'ignore', stderr],
          timeout: 10_000,
          killSignal: 'SIGKILL',
        }),
      );
      expect(child.status).toBe(0);
    }
    const logsDir = join(runDir, 'coordinator-logs');
    expect(existsSync(join(logsDir, 'native-stderr.log'))).toBe(true);
    expect(existsSync(join(runDir, 'coordinator.log'))).toBe(false);
    expect(existsSync(join(runDir, 'coordinator.log.1'))).toBe(false);
    const certified = readdirSync(logsDir).filter((name) => existsSync(join(logsDir, name, 'segments-closed')));
    expect(certified).toHaveLength(5);
  });
});

it.skipIf(process.platform !== 'linux')(
  'closes the private writer descriptor before renaming a segment (requires Linux /proc/self/fd)',
  () => {
    const runDir = mkdtempSync(join(dir, 'rename-proof-'));
    const result = spawnSync(process.execPath, [join(dir, 'stuck.cjs')], {
      env: { ...process.env, TEST_RUN_DIR: runDir, TEST_ROTATION_PROOF: '1' },
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
      killSignal: 'SIGKILL',
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toEqual([]);
  },
);

it('keeps a successful exit when the segment closure certificate cannot be written', () => {
  const runDir = mkdtempSync(join(dir, 'certificate-failure-'));
  const result = spawnSync(process.execPath, [join(dir, 'stuck.cjs')], {
    env: { ...process.env, TEST_RUN_DIR: runDir, TEST_CLOSE_FAILURE: '1' },
    stdio: 'ignore',
    timeout: 10_000,
    killSignal: 'SIGKILL',
  });
  expect(result.status).toBe(0);
  const log = latestPath(runDir);
  expect(readFileSync(log, 'utf8')).toBe('retained-without-certificate');
  expect(existsSync(join(dirname(log), 'segments-closed'))).toBe(false);
});

it('keeps in-process diagnostics when the inherited pipe reader exits', async () => {
  const runDir = mkdtempSync(join(dir, 'reader-exit-'));
  const reader = spawn(process.execPath, ['-e', 'process.stdin.resume();setTimeout(()=>process.exit(0),20)'], {
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  let child: ChildProcess | null = null;
  try {
    child = spawn(process.execPath, [join(dir, 'stuck.cjs')], {
      env: { ...process.env, TEST_RUN_DIR: runDir, TEST_PIPE_FAILURE: '1' },
      stdio: ['ignore', 'pipe', reader.stdin, 'ipc'],
    });
    reader.stdin.destroy();
    const output: Buffer[] = [];
    const stdout = child.stdout;
    if (stdout === null) throw new Error('Fixture writer stdout is unavailable');
    stdout.on('data', (chunk) => output.push(chunk));
    await writerMessage(child);
    await fixtureExit(reader);
    expect(reader.exitCode).toBe(0);
    child.send('reader-exited');
    await fixtureExit(child);
    expect(child.exitCode).toBe(0);
    expect(Buffer.concat(output).toString()).toBe('survived');
    expect(latestLog(runDir)).toBe('reader-already-exited');
  } finally {
    reader.stdin.destroy();
    await Promise.all([stopFixture(reader), child === null ? Promise.resolve() : stopFixture(child)]);
  }
});

describe('writer identity retention', () => {
  it('reuses one native file through repeated failed launches without allocating writer namespaces', () => {
    const runDir = mkdtempSync(join(dir, 'failed-launches-'));
    for (let attempt = 0; attempt < 100; attempt++) {
      expect(() =>
        withCoordinatorLog(runDir, () => {
          throw new Error('launch-refused');
        }),
      ).toThrow('launch-refused');
    }
    const logsDir = join(runDir, 'coordinator-logs');
    expect(readdirSync(logsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory())).toEqual([]);
    expect(readdirSync(logsDir).filter((name) => name.endsWith('.log'))).toEqual(['native-stderr.log']);
    expect(statSync(join(logsDir, 'native-stderr.log')).size).toBe(0);
  });

  it('keeps failed writer-record publication out of canonical namespaces and reaps its stages', () => {
    const runDir = mkdtempSync(join(dir, 'interrupted-publication-'));
    for (let attempt = 0; attempt < 12; attempt++) {
      const result = spawnSync(process.execPath, [join(dir, 'stuck.cjs')], {
        env: { ...process.env, TEST_RUN_DIR: runDir, TEST_RECORD_FAILURE: '1' },
        stdio: 'ignore',
        timeout: 10_000,
        killSignal: 'SIGKILL',
      });
      expect(result.status).toBe(0);
    }
    const logsDir = join(runDir, 'coordinator-logs');
    expect(readdirSync(logsDir).filter((name) => /^[0-9a-f-]{36}$/.test(name))).toEqual([]);
    expect(readdirSync(logsDir).filter((name) => name.startsWith('.stage-')).length).toBeLessThanOrEqual(1);
    const result = spawnSync(process.execPath, [join(dir, 'stuck.cjs')], {
      env: { ...process.env, TEST_RUN_DIR: runDir, TEST_PIPE: '1' },
      stdio: 'ignore',
      timeout: 10_000,
      killSignal: 'SIGKILL',
    });
    expect(result.status).toBe(0);
    expect(readdirSync(logsDir).filter((name) => name.startsWith('.stage-'))).toEqual([]);
  });

  it('keeps the earlier pointer after a single failed publication without retrying and reports its private path in health', () => {
    const runDir = mkdtempSync(join(dir, 'pointer-failure-'));
    const earlier = spawnSync(process.execPath, [join(dir, 'stuck.cjs')], {
      env: { ...process.env, TEST_RUN_DIR: runDir, TEST_PIPE: '1' },
      stdio: 'ignore',
      timeout: 10_000,
      killSignal: 'SIGKILL',
    });
    expect(earlier.status).toBe(0);
    const pointer = join(runDir, 'coordinator-logs/latest-coordinator.json');
    const before = readFileSync(pointer, 'utf8');
    const result = spawnSync(process.execPath, [join(dir, 'stuck.cjs')], {
      env: { ...process.env, TEST_RUN_DIR: runDir, TEST_POINTER_ONCE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
      killSignal: 'SIGKILL',
    });
    expect(result.stderr.toString()).toBe('');
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout.toString()) as {
      attempts: number;
      path: string;
      healthPath: string;
      text: string;
    };
    expect(report.attempts).toBe(1);
    expect(readFileSync(pointer, 'utf8')).toBe(before);
    expect(report.path).not.toBe((JSON.parse(before) as { path: string }).path);
    expect(report.healthPath).toBe(report.path);
    expect(report.text).toBe('after-publication-failure\n');
    expect(existsSync(join(dirname(report.path), 'pointer.tmp'))).toBe(false);
  });

  it('retires writer namespaces after repeated publication failures', () => {
    const runDir = mkdtempSync(join(dir, 'interrupted-pointers-'));
    const logsDir = join(runDir, 'coordinator-logs');
    let oldest: string | undefined;
    for (let attempt = 0; attempt < 12; attempt++) {
      const result = spawnSync(process.execPath, [join(dir, 'stuck.cjs')], {
        env: { ...process.env, TEST_RUN_DIR: runDir, TEST_POINTER_FAILURE: '1' },
        stdio: 'ignore',
        timeout: 10_000,
        killSignal: 'SIGKILL',
      });
      expect(result.status).toBe(0);
      const namespaces = readdirSync(logsDir).filter((name) => /^[0-9a-f-]{36}$/.test(name));
      expect(namespaces.length).toBeLessThanOrEqual(5);
      if (attempt === 0) {
        oldest = join(logsDir, namespaces[0]);
        expect(existsSync(join(oldest, 'pointer.tmp'))).toBe(false);
        expect(existsSync(join(oldest, 'writer.json'))).toBe(true);
      }
    }
    if (oldest === undefined) throw new Error('Fixture writer namespace was not created');
    expect(existsSync(oldest)).toBe(false);
    const result = spawnSync(process.execPath, [join(dir, 'stuck.cjs')], {
      env: { ...process.env, TEST_RUN_DIR: runDir, TEST_PIPE: '1' },
      stdio: 'ignore',
      timeout: 10_000,
      killSignal: 'SIGKILL',
    });
    expect(result.status).toBe(0);
    expect(readdirSync(logsDir).filter((name) => /^[0-9a-f-]{36}$/.test(name))).toHaveLength(5);
    expect(latestLog(runDir)).toBe('inherited-pipe-diagnostic\n');
  });

  it('bounds uncertified writer namespaces while preserving the first failure', () => {
    const runDir = mkdtempSync(join(dir, 'uncertified-writers-'));
    let first: string | undefined;
    for (let attempt = 0; attempt < 32; attempt++) {
      const result = withCoordinatorLog(runDir, (stderr) =>
        spawnSync(process.execPath, [join(dir, 'stuck.cjs')], {
          env: { ...process.env, TEST_RUN_DIR: runDir, TEST_UNCERTIFIED_EXIT: '1' },
          stdio: ['ignore', 'ignore', stderr],
          timeout: 10_000,
          killSignal: 'SIGKILL',
        }),
      );
      expect(result.status).toBe(0);
      if (attempt === 0) first = dirname(latestPath(runDir));
    }
    const logsDir = join(runDir, 'coordinator-logs');
    const namespaces = readdirSync(logsDir).filter((name) => /^[0-9a-f-]{36}$/.test(name));
    expect(namespaces).toHaveLength(11);
    expect(first).toBeDefined();
    expect(existsSync(first!)).toBe(true);
    expect(namespaces.every((name) => !existsSync(join(logsDir, name, 'segments-closed')))).toBe(true);
    expect(readdirSync(logsDir).filter((name) => name.endsWith('native-stderr.log'))).toEqual(['native-stderr.log']);
  });

  it.skipIf(process.platform !== 'linux').each(['coordinator', 'supervisor'] as const)(
    'preserves the first %s failure after a same-boot clock rollback despite older boot mtimes',
    (role) => {
      const runDir = mkdtempSync(join(dir, 'rollback-failure-run-'));
      const ownIncarnation = probeProcessIncarnation(process.pid, 'linux');
      const ownOrder = ownIncarnation === null ? null : processIncarnationStartOrder(ownIncarnation);
      if (ownOrder === null) throw new Error('Fixture requires the Linux boot identity');
      const incarnation = (bootId: string, ticks: number) => {
        const stat = `2147483000 (node) S ${Array(18).fill('0').join(' ')} ${ticks} 0`;
        const token = parseLinuxProcessIncarnation(bootId, stat);
        if (token === null) throw new Error('Fixture process incarnation did not parse');
        return token;
      };
      const olderBootClean = recordedWriter(runDir, role, 2_000, incarnation('older-boot', 1_000_000));
      writeFileSync(
        join(olderBootClean, 'segments-closed'),
        dirname(join(olderBootClean, 'current.log')).split('/').at(-1)!,
      );
      const previousFailure = recordedWriter(runDir, role, 999, incarnation(ownOrder.bootId, 99));
      const clean = recordedWriter(runDir, role, 1_000, incarnation(ownOrder.bootId, 100));
      writeFileSync(join(clean, 'segments-closed'), dirname(join(clean, 'current.log')).split('/').at(-1)!);
      const firstFailure = recordedWriter(runDir, role, 100, incarnation(ownOrder.bootId, 101));
      for (let start = 102; start <= 140; start++)
        recordedWriter(runDir, role, start, incarnation(ownOrder.bootId, start));
      const result = spawnSync(process.execPath, [join(dir, 'stuck.cjs')], {
        env: { ...process.env, TEST_RUN_DIR: runDir, TEST_ROLE: role, TEST_FAILED_EXIT: '1' },
        stdio: 'ignore',
        timeout: 10_000,
        killSignal: 'SIGKILL',
      });
      expect(result.status).toBe(1);
      expect(existsSync(firstFailure)).toBe(true);
      expect(existsSync(previousFailure)).toBe(false);
      expect(existsSync(clean)).toBe(true);
      expect(existsSync(olderBootClean)).toBe(true);
      const namespaces = readdirSync(join(runDir, 'coordinator-logs')).filter((name) => /^[0-9a-f-]{36}$/.test(name));
      expect(namespaces).toHaveLength(13);
    },
  );

  it.each(['coordinator', 'supervisor'] as const)(
    'preserves the first failure of the current %s restart loop within separate budgets',
    (role) => {
      const runDir = mkdtempSync(join(dir, 'failure-run-'));
      const previousFailure = recordedWriter(runDir, role, 1);
      const clean = recordedWriter(runDir, role, 2);
      writeFileSync(join(clean, 'segments-closed'), dirname(join(clean, 'current.log')).split('/').at(-1)!);
      const firstFailure = recordedWriter(runDir, role, 3);
      for (let age = 4; age <= 40; age++) recordedWriter(runDir, role, age);
      const result = spawnSync(process.execPath, [join(dir, 'stuck.cjs')], {
        env: { ...process.env, TEST_RUN_DIR: runDir, TEST_ROLE: role, TEST_FAILED_EXIT: '1' },
        stdio: 'ignore',
        timeout: 10_000,
        killSignal: 'SIGKILL',
      });
      expect(result.status).toBe(1);
      expect(existsSync(firstFailure)).toBe(true);
      expect(existsSync(previousFailure)).toBe(false);
      expect(existsSync(clean)).toBe(true);
      const logsDir = join(runDir, 'coordinator-logs');
      const namespaces = readdirSync(logsDir).filter((name) => /^[0-9a-f-]{36}$/.test(name));
      expect(namespaces).toHaveLength(12);
      expect(existsSync(join(dirname(latestPath(runDir, `latest-${role}.json`)), 'segments-closed'))).toBe(false);
    },
  );

  it.each([
    ['alive', true],
    ['unknown', true],
    ['reused', false],
  ] as const)('keeps exact identities when observation is %s: %s', async (observation, kept) => {
    const runDir = mkdtempSync(join(dir, 'identity-observation-'));
    recordedWriter(runDir, 'coordinator', 1);
    const oldest = recordedWriter(runDir, 'coordinator', 2);
    for (let age = 3; age <= 13; age++) recordedWriter(runDir, 'coordinator', age);
    const child = spawn(process.execPath, [join(dir, 'stuck.cjs')], {
      env: { ...process.env, TEST_RUN_DIR: runDir, TEST_RETENTION: '1', TEST_OBSERVATION: observation },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    try {
      await writerMessage(child);
      expect(existsSync(latestPath(runDir))).toBe(true);
      expect(existsSync(oldest)).toBe(kept);
    } finally {
      await stopFixture(child);
    }
  });

  it.each(['missing', 'unreadable'] as const)('keeps a namespace with a %s writer record', async (state) => {
    const runDir = mkdtempSync(join(dir, 'unreadable-writer-'));
    recordedWriter(runDir, 'coordinator', 1);
    const oldest = recordedWriter(runDir, 'coordinator', 2);
    const removable = recordedWriter(runDir, 'coordinator', 3);
    if (state === 'missing') unlinkSync(join(oldest, 'writer.json'));
    else writeFileSync(join(oldest, 'writer.json'), '{');
    for (let age = 4; age <= 15; age++) recordedWriter(runDir, 'coordinator', age);
    const child = spawn(process.execPath, [join(dir, 'stuck.cjs')], {
      env: { ...process.env, TEST_RUN_DIR: runDir, TEST_RETENTION: '1', TEST_OBSERVATION: 'absent' },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    try {
      await writerMessage(child);
      expect(existsSync(latestPath(runDir))).toBe(true);
      child.send('absent');
      await writerMessage(child);
      expect(readFileSync(join(oldest, 'current.log'), 'utf8')).toBe('uncertified diagnostics');
      expect(existsSync(removable)).toBe(false);
    } finally {
      await stopFixture(child);
    }
  });

  it('retries unknown liveness on the next retention pass and keeps the newest families per role', async () => {
    const runDir = mkdtempSync(join(dir, 'retry-identity-'));
    recordedWriter(runDir, 'coordinator', 1);
    const oldest = recordedWriter(runDir, 'coordinator', 2);
    for (let age = 3; age <= 13; age++) recordedWriter(runDir, 'coordinator', age);
    for (let age = 1; age <= 13; age++) recordedWriter(runDir, 'supervisor', age);
    const child = spawn(process.execPath, [join(dir, 'stuck.cjs')], {
      env: { ...process.env, TEST_RUN_DIR: runDir, TEST_RETENTION: '1', TEST_OBSERVATION: 'unknown' },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    try {
      await writerMessage(child);
      expect(existsSync(latestPath(runDir))).toBe(true);
      expect(existsSync(oldest)).toBe(true);
      child.send('absent');
      await writerMessage(child);
      expect(existsSync(oldest)).toBe(false);
      const counts = { coordinator: 0, supervisor: 0 };
      const logsDir = join(runDir, 'coordinator-logs');
      for (const name of readdirSync(logsDir)) {
        if (!/^[0-9a-f-]{36}$/.test(name)) continue;
        const writer = JSON.parse(readFileSync(join(logsDir, name, 'writer.json'), 'utf8')) as {
          role: keyof typeof counts;
        };
        counts[writer.role]++;
      }
      expect(counts).toEqual({ coordinator: 11, supervisor: 10 });
    } finally {
      await stopFixture(child);
    }
  });

  it('leaves the serving coordinator pointer unchanged when a replacement supervisor starts', async () => {
    const runDir = mkdtempSync(join(dir, 'role-pointers-'));
    const coordinator = withCoordinatorLog(runDir, (stderr) =>
      spawn(process.execPath, [join(dir, 'stuck.cjs')], {
        env: { ...process.env, TEST_RUN_DIR: runDir, TEST_SERVING: '1' },
        stdio: ['ignore', 'ignore', stderr, 'ipc'],
      }),
    );
    try {
      await writerMessage(coordinator);
      const coordinatorPointer = join(runDir, 'coordinator-logs/latest-coordinator.json');
      const before = readFileSync(coordinatorPointer, 'utf8');
      const supervisor = withCoordinatorLog(runDir, (stderr) =>
        spawnSync(process.execPath, [join(dir, 'stuck.cjs')], {
          env: { ...process.env, TEST_RUN_DIR: runDir, TEST_PIPE: '1', TEST_ROLE: 'supervisor' },
          stdio: ['ignore', 'ignore', stderr],
          timeout: 10_000,
          killSignal: 'SIGKILL',
        }),
      );
      expect(supervisor.status).toBe(0);
      expect(readFileSync(coordinatorPointer, 'utf8')).toBe(before);
      const current = JSON.parse(before) as { path: string; writer: { pid: number; incarnation: string } };
      expect(current.writer.pid).toBe(coordinator.pid);
      expect(current.writer.incarnation).not.toBe('');
      expect(latestPath(runDir, 'latest-supervisor.json')).not.toBe(current.path);
      expect(readFileSync(current.path, 'utf8')).toBe('writer-ready\n');
    } finally {
      await stopFixture(coordinator);
    }
  });

  it.skipIf(process.platform !== 'linux')(
    'does not pass the private segment to a withCoordinatorLog child (requires Linux /proc/self/fd)',
    () => {
      const runDir = mkdtempSync(join(dir, 'private-launch-fd-'));
      const result = spawnSync(process.execPath, [join(dir, 'stuck.cjs')], {
        env: { ...process.env, TEST_RUN_DIR: runDir, TEST_LAUNCHED_CHILD_FDS: '1' },
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 10_000,
        killSignal: 'SIGKILL',
      });
      expect(result.status).toBe(0);
      const report = JSON.parse(result.stdout.toString()) as { status: number; held: string[]; path: string };
      expect(report.status).toBe(0);
      expect(report.held).toEqual([]);
      expect(readFileSync(join(runDir, 'coordinator-logs/native-stderr.log'), 'utf8')).toBe('launched-child-native');
      expect(readFileSync(report.path, 'utf8')).toBe('parent-private-diagnostic');
    },
  );
});

it.each(['alive', 'unknown'] as const)(
  'keeps an interrupted publication stage while its writer is %s and retires it after absence',
  async (observation) => {
    const runDir = mkdtempSync(join(dir, 'stage-absence-'));
    const digest = createHash('sha256').update(testIncarnation('stale-writer')).digest('hex');
    const stage = join(runDir, 'coordinator-logs', `.stage-coordinator-2147483000-${digest}`);
    mkdirSync(stage, { recursive: true });
    writeFileSync(join(stage, 'writer.json'), '{');
    const child = spawn(process.execPath, [join(dir, 'stuck.cjs')], {
      env: { ...process.env, TEST_RUN_DIR: runDir, TEST_RETENTION: '1', TEST_OBSERVATION: observation },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    try {
      await writerMessage(child);
      expect(existsSync(latestPath(runDir))).toBe(true);
      expect(readFileSync(join(stage, 'writer.json'), 'utf8')).toBe('{');
      child.send('absent');
      await writerMessage(child);
      expect(existsSync(stage)).toBe(false);
    } finally {
      await stopFixture(child);
    }
  },
);

it.each([
  ['coordinator', 'supervisor'],
  ['supervisor', 'coordinator'],
] as const)('labels legacy diagnostic pointers when %s publishes before %s', (first, second) => {
  const runDir = mkdtempSync(join(dir, 'legacy-role-pointers-'));
  const legacy = join(runDir, 'coordinator.log');
  writeFileSync(legacy, 'older-build-diagnostic\n');
  for (const role of [first, second]) {
    const result = spawnSync(process.execPath, [join(dir, 'stuck.cjs')], {
      env: { ...process.env, TEST_RUN_DIR: runDir, TEST_GETTER: '1', TEST_ROLE: role },
      stdio: 'ignore',
      timeout: 10_000,
      killSignal: 'SIGKILL',
    });
    expect(result.status).toBe(0);
  }
  const content = readFileSync(legacy, 'utf8');
  expect(content).toMatch(/^older-build-diagnostic\n/);
  const pointers = content.trimEnd().split('\n').slice(1);
  const label = { coordinator: 'Coordinator', supervisor: 'Supervisor' };
  for (const [position, role] of [first, second].entries()) {
    expect(pointers[position]).toContain(label[role]);
    expect(pointers[position]).toContain(join(runDir, 'coordinator-logs', `latest-${role}.json`));
  }
});

it.each(['coordinator', 'supervisor'] as const)('returns the real process-owned path only for the %s role', (role) => {
  const runDir = mkdtempSync(join(dir, 'real-getter-'));
  const result = spawnSync(process.execPath, [join(dir, 'stuck.cjs')], {
    env: { ...process.env, TEST_RUN_DIR: runDir, TEST_GETTER: '1', TEST_ROLE: role },
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 10_000,
    killSignal: 'SIGKILL',
  });
  expect(result.status).toBe(0);
  const report = JSON.parse(result.stdout.toString()) as { actual: string | null; ownPath: string };
  expect(existsSync(report.ownPath)).toBe(true);
  expect(report.actual).toBe(role === 'coordinator' ? report.ownPath : null);
});

it('records the actual process-owned coordinator segment in a real startup diagnostic', () => {
  const home = mkdtempSync(join(dir, 'real-startup-diagnostic-'));
  const result = spawnSync(process.execPath, [fixture], {
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      TEST_REAL_RUNTIME: '1',
      TEST_NO_SUCCESSION: '1',
      CORAL_FLAVOR: 'dev',
      CORAL_SENTINEL_ID: undefined,
    },
    stdio: 'ignore',
    timeout: 10_000,
    killSignal: 'SIGKILL',
  });
  expect(result.status).toBe(1);
  const runDir = join(home, '.coral', 'gen2', 'run-dev');
  const record = JSON.parse(readFileSync(join(runDir, 'startup-diagnostic.json'), 'utf8')) as {
    coordinatorLogPath?: string;
  };
  expect(record.coordinatorLogPath).toBe(latestPath(runDir));
  expect(latestLog(runDir)).toContain('diagnostic-regression');
});

it('records its process-owned startup path and failure text even when pointer publication fails', () => {
  const home = mkdtempSync(join(dir, 'startup-pointer-failure-'));
  const result = spawnSync(process.execPath, [fixture], {
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      TEST_REAL_RUNTIME: '1',
      TEST_NO_SUCCESSION: '1',
      TEST_BOOT_POINTER_ONCE: '1',
      CORAL_FLAVOR: 'dev',
      CORAL_SENTINEL_ID: undefined,
    },
    stdio: 'ignore',
    timeout: 10_000,
    killSignal: 'SIGKILL',
  });
  expect(result.status).toBe(1);
  const runDir = join(home, '.coral', 'gen2', 'run-dev');
  const logsDir = join(runDir, 'coordinator-logs');
  const namespaces = readdirSync(logsDir).filter((name) => /^[0-9a-f-]{36}$/.test(name));
  expect(namespaces).toHaveLength(1);
  const path = join(logsDir, namespaces[0], 'current.log');
  const record = JSON.parse(readFileSync(join(runDir, 'startup-diagnostic.json'), 'utf8')) as {
    coordinatorLogPath?: string;
  };
  expect(record.coordinatorLogPath).toBe(path);
  expect(readFileSync(path, 'utf8')).toContain('diagnostic-regression');
  expect(existsSync(join(logsDir, 'latest-coordinator.json'))).toBe(false);
});

it.each(['rename', 'open'] as const)(
  'recovers bounded diagnostic writes after a transient rotation %s failure',
  (operation) => {
    const runDir = mkdtempSync(join(dir, 'rotation-recovery-'));
    const result = spawnSync(process.execPath, [join(dir, 'stuck.cjs')], {
      env: { ...process.env, TEST_RUN_DIR: runDir, TEST_ROTATION_FAILURE: operation },
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
      killSignal: 'SIGKILL',
    });
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout.toString()) as { path: string; failed: boolean; held: string[][] };
    expect(report.failed).toBe(true);
    if (process.platform === 'linux') {
      expect(report.held.length).toBeGreaterThan(0);
      expect(report.held.every((descriptors) => descriptors.length === 0)).toBe(true);
    }
    expect(readFileSync(report.path, 'utf8')).toContain('recovered-after-rotation-failure');
    expect(statSync(report.path).size).toBeLessThanOrEqual(LOG_ROTATE_THRESHOLD_BYTES);
    expect(statSync(`${report.path}.1`).size).toBeLessThanOrEqual(LOG_ROTATE_THRESHOLD_BYTES);
  },
);

it('preserves a namespace selected during its decisive absence observation', async () => {
  const runDir = mkdtempSync(join(dir, 'pointer-observation-order-'));
  const selected = recordedWriter(runDir, 'coordinator', 2);
  recordedWriter(runDir, 'coordinator', 1);
  for (let age = 3; age <= 13; age++) recordedWriter(runDir, 'coordinator', age);
  const path = join(selected, 'current.log');
  const child = spawn(process.execPath, [join(dir, 'stuck.cjs')], {
    env: {
      ...process.env,
      TEST_RUN_DIR: runDir,
      TEST_RETENTION: '1',
      TEST_OBSERVATION: 'absent',
      TEST_POINTER_TARGET: path,
    },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  try {
    const current = (await writerMessage(child)) as { path: string };
    expect(current.path).not.toBe(path);
    expect(existsSync(current.path)).toBe(true);
    expect(latestPath(runDir)).toBe(path);
    expect(readFileSync(path, 'utf8')).toBe('uncertified diagnostics');
    child.send('absent');
    await writerMessage(child);
    expect(latestPath(runDir)).toBe(path);
    expect(existsSync(path)).toBe(true);
  } finally {
    await stopFixture(child);
  }
});
