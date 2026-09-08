import { spawn, type ChildProcess } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { currentCoralStoreFormat } from '#src/store-format.js';
import { CURRENT_STRICT_BUNDLE_MANIFEST_FILE } from '#src/infra/bundle-manifest-address.js';
import { readBuildFlavor } from '#src/infra/bundle-manifest.js';
import { coordinatorPaths } from '#src/infra/path/coordinator.js';
import {
  readProviderProxySetHolderStatusDirect,
  type DirectProviderProxySetHolderStatus,
  type DirectProviderProxySetHolderStatusRow,
} from '#src/cli/commands/backend.js';
import { observeProcessLiveness } from '#src/infra/node-process.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { storePaths } from '#src/infra/path/store.js';
import { openStoreDatabase } from '#src/store/db.js';
import { readProviderOperationForJob } from '#src/store/provider-operation-journal.js';
import type { ProviderOperationRecord } from '#src/store/provider-operation-record.js';
import {
  providerProxyAdoptionWindowMs,
  resolveProviderProxyDeadlineConfiguration,
} from '#src/provider-proxy/orphan-deadline.js';
import { assertLifecycleBundleSetFresh } from '#tests/support/bundle-build-freshness.js';
import { createTemporaryHomeOwner, type TemporaryHome } from '#tests/support/temporary-home-lifecycle.js';
import { waitForCondition } from '#tests/support/wait-for-condition.js';

const REPO_ROOT = process.cwd();
const SOURCE_BACKEND_BUNDLE = join(REPO_ROOT, 'clients', 'build', 'coral-backend.cjs');
const SOURCE_CLI_BUNDLE = join(REPO_ROOT, 'clients', 'build', 'coral-cli.cjs');
const SOURCE_CLAUDE_APPSERVER_BUNDLE = join(REPO_ROOT, 'clients', 'build', 'coral-claude-appserver.cjs');
const SOURCE_DURABLE_WRAPPER_BUNDLE = join(REPO_ROOT, 'clients', 'build', 'coral-durable-wrapper.cjs');
const SOURCE_LEGACY_MANIFEST = join(REPO_ROOT, 'clients', 'build', 'manifest.json');
const SOURCE_STRICT_MANIFEST = join(REPO_ROOT, 'clients', 'build', CURRENT_STRICT_BUNDLE_MANIFEST_FILE);
const SOURCE_SQLITE3_DIR = join(REPO_ROOT, 'node_modules', 'better-sqlite3');

function requireReadableHolderStatusRow(
  row: DirectProviderProxySetHolderStatusRow | undefined,
): DirectProviderProxySetHolderStatus {
  if (row === undefined) throw new Error('provider proxy set holder-status row was absent');
  if ('kind' in row) {
    if (row.kind === 'legacy-capsule') {
      throw new Error(`provider proxy capsule version ${row.capsule.version} is not dialable: ${row.path}`);
    }
    throw new Error(`provider proxy capsule was unreadable: ${row.path} (${row.reason})`);
  }
  return row;
}

/** The acceptance hold must use wall-clock time. */
const STARVATION_HOLD_MS = 60_000;

const CONFIGURATION = resolveProviderProxyDeadlineConfiguration({ get: (name) => process.env[name] });

/** The alive-only assertion must allow one adoption window plus probe and wake latency. */
const ALIVE_CROSSOVER_MS = providerProxyAdoptionWindowMs(CONFIGURATION) + 10_000;

/** Each CLI watchdog must expire before the outer test timeout. */
const QUICK_CLI_WATCHDOG_MS = 30_000;

const PRE_FREEZE_SETUP_MARGIN_MS = 20_000;
const POST_RESUME_MARGIN_MS = 15_000;
const TEST_TIMEOUT_MS =
  PRE_FREEZE_SETUP_MARGIN_MS +
  STARVATION_HOLD_MS +
  POST_RESUME_MARGIN_MS +
  QUICK_CLI_WATCHDOG_MS +
  CONFIGURATION.orphanTimeoutMs +
  10_000;

/** The held CLI watchdog must not preempt any assertion in the outer test. */
const HELD_CLI_WATCHDOG_MS = TEST_TIMEOUT_MS + 30_000;

const tempRoots: string[] = [];
const temporaryHomes = createTemporaryHomeOwner();

type Fixture = Readonly<{
  root: string;
  home: TemporaryHome;
  projectRoot: string;
  binDir: string;
  fakeStateDir: string;
  flavor: 'prod' | 'dev';
}>;

const FAKE_CODEX_APP_SERVER = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
let turnStartSeen = 0;

if (process.argv[2] === 'app-server' && process.argv[3] === '--help') {
  process.stdout.write('fake codex app-server\\n');
  process.exit(0);
}
if (process.argv[2] !== 'app-server') {
  process.stderr.write('unsupported fake codex command\\n');
  process.exit(1);
}

const stateDir = path.join(process.env.HOME, '.fake-codex-state');
const secondOperation = fs.existsSync(path.join(stateDir, 'second-operation-armed'));
const threadId = 'starved-codex-session';
const turnId = 'starved-codex-turn';

function signal(name, value = 'ready') {
  fs.writeFileSync(path.join(stateDir, name), value);
}

function afterGate(name, action) {
  const gatePath = path.join(stateDir, name);
  const poll = () => {
    if (fs.existsSync(gatePath)) {
      action();
      return;
    }
    setTimeout(poll, 10);
  };
  poll();
}

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\\n');
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  switch (message.method) {
    case 'initialize':
      send({ id: message.id, result: {} });
      break;
    case 'config/read':
      send({ id: message.id, result: { config: {} } });
      break;
    case 'thread/start':
      send({ method: 'thread/started', params: { thread: { id: threadId } } });
      send({ id: message.id, result: { thread: { id: threadId } } });
      break;
    case 'turn/start': {
      turnStartSeen += 1;
      signal('turn-start-seen-' + turnStartSeen);
      const answerTurn = () => {
        send({
          method: 'turn/started',
          params: { threadId, turn: { id: turnId, status: 'inProgress' } },
        });
        send({ id: message.id, result: { turn: { id: turnId, status: 'inProgress' } } });
        send({
          method: 'item/completed',
          params: {
            threadId,
            turnId,
            item: { type: 'agentMessage', phase: 'final_answer', text: 'scripted terminal output' },
          },
        });
        send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed' } } });
      };
      if (secondOperation) {
        signal('turn-start-pending', String(process.pid));
        afterGate('turn-complete-gate', answerTurn);
      } else {
        answerTurn();
      }
      break;
    }
    case 'turn/interrupt':
      send({ id: message.id, result: { threadId, turnId } });
      break;
    default:
      send({ id: message.id, error: { code: -32601, message: 'unsupported method' } });
      break;
  }
});
`;

function createFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'coral-ac8-plug-'));
  const projectRoot = join(root, 'project');
  const binDir = join(root, 'bin');
  tempRoots.push(root);

  mkdirSync(join(root, 'bridge'), { recursive: true });
  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  copyFileSync(SOURCE_BACKEND_BUNDLE, join(root, 'bridge', 'coral-backend.cjs'));
  copyFileSync(SOURCE_CLI_BUNDLE, join(root, 'bridge', 'coral-cli.cjs'));
  // The coordinator validates its whole adjacent build set at startup, so the Claude appserver bundle must be
  // present or boot aborts on build identity, even though this test never drives a Claude job.
  copyFileSync(SOURCE_CLAUDE_APPSERVER_BUNDLE, join(root, 'bridge', 'coral-claude-appserver.cjs'));
  copyFileSync(SOURCE_DURABLE_WRAPPER_BUNDLE, join(root, 'bridge', 'coral-durable-wrapper.cjs'));
  copyFileSync(SOURCE_LEGACY_MANIFEST, join(root, 'bridge', 'manifest.json'));
  copyFileSync(SOURCE_STRICT_MANIFEST, join(root, 'bridge', CURRENT_STRICT_BUNDLE_MANIFEST_FILE));
  const flavor = readBuildFlavor(root);
  const home = temporaryHomes.create('coral-ac8-home-', flavor);
  const fakeStateDir = join(home, '.fake-codex-state');
  mkdirSync(fakeStateDir, { recursive: true });
  mkdirSync(join(home, '.codex'), { recursive: true });
  writeFileSync(join(binDir, 'codex'), FAKE_CODEX_APP_SERVER, 'utf-8');
  chmodSync(join(binDir, 'codex'), 0o755);
  // `account_id` is what makes this a bindable ChatGPT-mode profile: Codex account binding resolves its
  // subject from it. Without it the launch fails on provider identity before the coordinator is exercised.
  writeFileSync(
    join(home, '.codex', 'auth.json'),
    JSON.stringify({ tokens: { access_token: 'fake-access-token', account_id: 'fake-account-id' } }),
    'utf-8',
  );

  mkdirSync(join(root, 'node_modules'), { recursive: true });
  symlinkSync(SOURCE_SQLITE3_DIR, join(root, 'node_modules', 'better-sqlite3'), 'dir');

  return { root, home, projectRoot, binDir, fakeStateDir, flavor };
}

function coordinatorLogPath(fixture: Fixture): string {
  return join(coordinatorPaths(fixture.flavor, { baseDir: join(fixture.home, '.coral') }).runDir, 'coordinator.log');
}

function providerSocketCount(fixture: Fixture): number {
  const coralRoot = join(fixture.home, '.coral');
  if (!existsSync(coralRoot)) return 0;
  return readdirSync(coralRoot, { recursive: true }).filter(
    (entry) => typeof entry === 'string' && entry.includes('provider-') && entry.endsWith('.sock'),
  ).length;
}

type CliRun = Readonly<{ child: ChildProcess; stdout(): string; stderr(): string; completed: Promise<number> }>;

function startCli(fixture: Fixture, promptPath: string, watchdogMs: number): CliRun {
  // A test CLI must not inherit its parent's Coral child identity.
  const {
    CORAL_CHILD: _coralChild,
    CORAL_CHILD_PRINCIPAL_HANDLE: _childPrincipal,
    CORAL_JOB_ID: _coralJobId,
    CORAL_SESSION_ID: _coralSessionId,
    ...topLevelEnv
  } = process.env;
  const child = spawn('node', [join(fixture.root, 'bridge', 'coral-cli.cjs'), 'codex', '-i', promptPath], {
    cwd: fixture.projectRoot,
    env: {
      ...topLevelEnv,
      ...temporaryHomes.environment(fixture.home),
      TMPDIR: fixture.home,
      PATH: `${fixture.binDir}:${process.env.PATH ?? ''}`,
      // Coordinator starvation must remain isolated from KB background work.
      CORAL_KB_ENABLE: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const completed = new Promise<number>((resolve, reject) => {
    // A child watchdog must surface diagnostics before the enclosing test times out.
    let timeoutFailure: Error | null = null;
    const timeout = setTimeout(() => {
      timeoutFailure = new Error(`coral-cli timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`);
      child.kill('SIGKILL');
    }, watchdogMs);
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', (status) => {
      clearTimeout(timeout);
      if (timeoutFailure !== null) reject(timeoutFailure);
      else resolve(status ?? -1);
    });
  });
  return { child, stdout: () => stdout, stderr: () => stderr, completed };
}

function launchedJobId(stdout: string): string | null {
  return stdout.match(/^Provider job (\S+) (?:launch accepted|queued) \(provider session \S+\)$/m)?.[1] ?? null;
}

async function waitForCliGate(run: CliRun, check: () => boolean, label: string): Promise<void> {
  await Promise.race([
    waitForCondition(check, 30_000),
    run.completed.then((status) => {
      throw new Error(
        `${label} was never reached before coral-cli exited with status ${String(status)}\n` +
          `stdout:\n${run.stdout()}\nstderr:\n${run.stderr()}`,
      );
    }),
  ]);
}

function readDurableOperation(fixture: Fixture, jobId: string): ProviderOperationRecord | null {
  const runtime = createRealRuntime('prod');
  const db = openStoreDatabase({
    storeFormat: currentCoralStoreFormat(),
    path: storePaths(fixture.flavor, { baseDir: join(fixture.home, '.coral') }).dbFile,
    storage: runtime.storage,
    readonly: true,
  });
  try {
    return readProviderOperationForJob(db, jobId);
  } finally {
    db.close();
  }
}

/** On Linux, stopped state must be observed from `/proc/<pid>/status`, not inferred from timing. */
function isStoppedOnLinux(pid: number): boolean {
  try {
    return /^State:\s+T/m.test(readFileSync(`/proc/${pid}/status`, 'utf8'));
  } catch {
    return false;
  }
}

afterEach(async () => {
  await temporaryHomes.cleanup();
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('provider-proxy starvation (AC8)', () => {
  it.skipIf(process.platform !== 'linux')(
    'keeps a live claim through a real 60-second coordinator freeze, then still reaps it once the coordinator is actually gone',
    async () => {
      const testStart = Date.now();
      const mark = (label: string): void => {
        console.error(`[ac8] +${Date.now() - testStart}ms ${label}`);
      };
      mark('test start');
      assertLifecycleBundleSetFresh(REPO_ROOT);
      const fixture = createFixture();
      // The requirement's own premise, checked rather than assumed: a hold shorter than the mechanism's own
      // death bound would prove nothing about tolerating it.
      expect(STARVATION_HOLD_MS).toBeGreaterThan(CONFIGURATION.orphanTimeoutMs);

      const throwawayPromptPath = join(fixture.projectRoot, 'throwaway-prompt.txt');
      writeFileSync(throwawayPromptPath, 'warm the set up before holding the real one', 'utf-8');
      const throwaway = startCli(fixture, throwawayPromptPath, QUICK_CLI_WATCHDOG_MS);
      mark('throwaway launched');
      await waitForCliGate(throwaway, () => launchedJobId(throwaway.stdout()) !== null, 'throwaway job launch');
      const throwawayJobId = launchedJobId(throwaway.stdout());
      if (throwawayJobId === null) throw new Error('throwaway CLI never reported its provider job id');
      const throwawayStatus = await throwaway.completed;
      mark('throwaway completed');
      if (throwawayStatus !== 0) {
        throw new Error(
          `throwaway coral-cli exited with status ${throwawayStatus}\n` +
            `stdout:\n${throwaway.stdout()}\nstderr:\n${throwaway.stderr()}`,
        );
      }
      expect(throwaway.stderr()).toBe('');
      expect(throwaway.stdout()).toMatch(new RegExp(`^Job ${throwawayJobId} completed$`, 'm'));
      await waitForCondition(() => providerSocketCount(fixture) >= 3, 10_000);

      writeFileSync(join(fixture.fakeStateDir, 'second-operation-armed'), 'armed');
      const heldPromptPath = join(fixture.projectRoot, 'held-prompt.txt');
      writeFileSync(heldPromptPath, 'exercise a coordinator starved for 60 seconds', 'utf-8');

      const held = startCli(fixture, heldPromptPath, HELD_CLI_WATCHDOG_MS);
      mark('held launched');
      try {
        await waitForCliGate(held, () => launchedJobId(held.stdout()) !== null, 'held job launch');
        const heldJobId = launchedJobId(held.stdout());
        if (heldJobId === null) throw new Error('held CLI never reported its provider job id');

        await waitForCliGate(
          held,
          () => existsSync(join(fixture.fakeStateDir, 'turn-start-pending')),
          'turn/start gate',
        );
        mark('held parked at turn/start');
        const appServerPid = Number.parseInt(
          readFileSync(join(fixture.fakeStateDir, 'turn-start-pending'), 'utf8'),
          10,
        );
        if (!Number.isSafeInteger(appServerPid) || appServerPid <= 0) {
          throw new Error(`fake app-server published invalid pid ${String(appServerPid)}`);
        }
        // The later CLI must not inherit the held turn's parking behavior.
        rmSync(join(fixture.fakeStateDir, 'second-operation-armed'), { force: true });

        await waitForCondition(() => readDurableOperation(fixture, heldJobId) !== null, 10_000).catch(() => {
          throw new Error(`provider operation for ${heldJobId} never became durably readable at all`);
        });
        await waitForCondition(() => readDurableOperation(fixture, heldJobId)?.phase === 'executing', 10_000).catch(
          () => {
            const observed = readDurableOperation(fixture, heldJobId);
            throw new Error(
              `provider operation for ${heldJobId} never reached 'executing'; observed phase: ` +
                (observed === null ? 'null (no record)' : observed.phase),
            );
          },
        );
        const heldOperation = readDurableOperation(fixture, heldJobId);
        if (heldOperation === null || heldOperation.phase !== 'executing') {
          throw new Error(
            `provider operation for ${heldJobId} was 'executing' one poll ago but reads ` +
              (heldOperation === null ? 'null (no record)' : heldOperation.phase) +
              ' now',
          );
        }
        mark('held operation record readable and executing');
        const { guardian, reaper, proxy } = heldOperation.locator;

        await waitForCondition(() => temporaryHomes.readDiscovery(fixture.home).kind === 'record', 10_000);
        const discoveryBefore = temporaryHomes.readDiscovery(fixture.home);
        if (discoveryBefore.kind !== 'record') throw new Error('no coordinator discovery record');
        const coordinatorPid = discoveryBefore.record.pid;

        const targetPids = {
          coordinator: coordinatorPid,
          appServer: appServerPid,
          guardian: guardian.pid,
          reaper: reaper.pid,
          proxy: proxy.pid,
        };
        expect(new Set(Object.values(targetPids)).size).toBe(5);
        expect(Object.values(targetPids).every((pid) => observeProcessLiveness(pid) === 'alive')).toBe(true);

        const runtime = createRealRuntime(fixture.flavor, { baseDir: join(fixture.home, '.coral') });

        // A published holder must remain unobservable until identity-bound observation supplies evidence.
        const baseline = await readProviderProxySetHolderStatusDirect(runtime);
        expect(baseline).toHaveLength(1);
        const baselineSet = requireReadableHolderStatusRow(baseline[0]);
        expect(baselineSet.guardian).toMatchObject({
          kind: 'answered',
          status: { disposition: 'unobservable', phase: 'published' },
        });
        expect(baselineSet.reaper).toMatchObject({
          kind: 'answered',
          status: { disposition: 'unobservable', phase: 'published' },
        });
        const baselineSequence = {
          guardian: baselineSet.guardian.kind === 'answered' ? baselineSet.guardian.status.transitionSequence : null,
          reaper: baselineSet.reaper.kind === 'answered' ? baselineSet.reaper.status.transitionSequence : null,
        };
        mark('baseline read');

        process.kill(coordinatorPid, 'SIGSTOP');
        let latestReadings: Awaited<ReturnType<typeof readProviderProxySetHolderStatusDirect>> | null = null;
        try {
          await waitForCondition(() => isStoppedOnLinux(coordinatorPid), 5_000);
          mark('freeze entered, T confirmed');

          const holdStart = Date.now();
          let observations = 0;
          while (Date.now() - holdStart < STARVATION_HOLD_MS - 5_000) {
            expect(isStoppedOnLinux(coordinatorPid)).toBe(true);
            // Freezing the coordinator must not suspend independent enforcer processes.
            expect(isStoppedOnLinux(guardian.pid)).toBe(false);
            expect(isStoppedOnLinux(reaper.pid)).toBe(false);
            const readings = await readProviderProxySetHolderStatusDirect(runtime);
            latestReadings = readings;
            expect(readings).toHaveLength(1);
            const set = requireReadableHolderStatusRow(readings[0]);
            const elapsed = Date.now() - holdStart;
            for (const role of ['guardian', 'reaper'] as const) {
              const reading = set[role];
              // Silence must never be reported as departure; after the observation window, life must be explicit.
              expect(reading).toMatchObject({ kind: 'answered' });
              const disposition = reading.kind === 'answered' ? reading.status.disposition : null;
              expect(disposition).not.toBe('departed');
              if (elapsed >= ALIVE_CROSSOVER_MS) expect(disposition).toBe('alive');
            }
            expect(Object.values(targetPids).every((pid) => observeProcessLiveness(pid) === 'alive')).toBe(true);
            observations += 1;
            mark(`freeze poll #${observations} (elapsed ${elapsed}ms)`);
            await new Promise((resolve) => setTimeout(resolve, 5_000));
          }
          expect(observations).toBeGreaterThan(1);
          // The coordinator must remain stopped for the full acceptance interval.
          const remainingHoldMs = STARVATION_HOLD_MS - (Date.now() - holdStart);
          if (remainingHoldMs > 0) await new Promise((resolve) => setTimeout(resolve, remainingHoldMs));
          expect(Date.now() - holdStart).toBeGreaterThanOrEqual(STARVATION_HOLD_MS);
          expect(Object.values(targetPids).every((pid) => observeProcessLiveness(pid) === 'alive')).toBe(true);
          mark('hold complete');
        } finally {
          // A failed assertion must not leave the coordinator stopped.
          process.kill(coordinatorPid, 'SIGCONT');
          mark('SIGCONT sent');
        }
        await waitForCondition(() => !isStoppedOnLinux(coordinatorPid), 5_000);
        mark('resume confirmed');

        // Life requires fresh identity-bound evidence, not merely an unchanged unobservable disposition.
        const latestSet = requireReadableHolderStatusRow(latestReadings?.[0]);
        const guardianAfterHold = latestSet.guardian;
        const reaperAfterHold = latestSet.reaper;
        expect(guardianAfterHold?.kind === 'answered' ? guardianAfterHold.status.transitionSequence : null).toBe(
          baselineSequence.guardian === null ? null : baselineSequence.guardian + 1,
        );
        expect(reaperAfterHold?.kind === 'answered' ? reaperAfterHold.status.transitionSequence : null).toBe(
          baselineSequence.reaper === null ? null : baselineSequence.reaper + 1,
        );

        const afterResume = await readProviderProxySetHolderStatusDirect(runtime);
        expect(afterResume).toHaveLength(1);
        const afterResumeSet = requireReadableHolderStatusRow(afterResume[0]);
        expect(afterResumeSet.guardian).toMatchObject({ kind: 'answered', status: { disposition: 'alive' } });
        expect(afterResumeSet.reaper).toMatchObject({ kind: 'answered', status: { disposition: 'alive' } });
        expect(
          afterResumeSet.guardian.kind === 'answered' ? afterResumeSet.guardian.status.transitionSequence : null,
        ).toBe(baselineSequence.guardian === null ? null : baselineSequence.guardian + 1);
        expect(afterResumeSet.reaper.kind === 'answered' ? afterResumeSet.reaper.status.transitionSequence : null).toBe(
          baselineSequence.reaper === null ? null : baselineSequence.reaper + 1,
        );
        mark('post-resume reads done');

        const coordinatorLog = readFileSync(coordinatorLogPath(fixture), 'utf-8');
        expect(coordinatorLog).not.toContain('action=stop-and-reap');
        expect(coordinatorLog).not.toContain('action=await-containment-absence');

        const quickPromptPath = join(fixture.projectRoot, 'quick-prompt.txt');
        writeFileSync(quickPromptPath, 'prove the route survives without freeing the held turn', 'utf-8');
        const quick = startCli(fixture, quickPromptPath, QUICK_CLI_WATCHDOG_MS);
        mark('quick job launched');
        await waitForCliGate(quick, () => launchedJobId(quick.stdout()) !== null, 'quick job launch');
        await waitForCliGate(
          quick,
          () => existsSync(join(fixture.fakeStateDir, 'turn-start-seen-2')),
          'quick reaching the provider through the surviving route',
        );
        mark('quick reached turn/start on the surviving route');
        quick.child.kill('SIGKILL');
        expect(await readProviderProxySetHolderStatusDirect(runtime)).toHaveLength(1);

        const heldAfterResume = readDurableOperation(fixture, heldJobId);
        if (heldAfterResume === null || heldAfterResume.phase !== 'executing') {
          throw new Error(`held operation for ${heldJobId} did not survive the freeze at 'executing'`);
        }

        writeFileSync(join(fixture.fakeStateDir, 'turn-complete-gate'), 'continue');
        const heldStatus = await held.completed;
        mark('held work completed after resume');
        if (heldStatus !== 0) {
          throw new Error(
            `held coral-cli exited with status ${heldStatus}\n` +
              `stdout:\n${held.stdout()}\nstderr:\n${held.stderr()}`,
          );
        }
        expect(held.stderr()).toBe('');
        expect(held.stdout()).toMatch(new RegExp(`^Job ${heldJobId} completed$`, 'm'));

        // Coordinator death must lead the held containment to confirmed absence within its death bound.
        const killedAt = Date.now();
        process.kill(coordinatorPid, 'SIGKILL');
        mark('SIGKILL sent to coordinator');
        let lastPhaseTwoPollLogSec = -1;
        await waitForCondition(() => {
          const elapsedSec = Math.floor((Date.now() - killedAt) / 1_000);
          if (elapsedSec !== lastPhaseTwoPollLogSec) {
            lastPhaseTwoPollLogSec = elapsedSec;
            mark(`phase two poll, +${elapsedSec}s since SIGKILL`);
          }
          return [guardian.pid, reaper.pid, proxy.pid].every((pid) => observeProcessLiveness(pid) === 'absent');
        }, CONFIGURATION.orphanTimeoutMs + 10_000);
        mark('phase two absence confirmed');
        expect(Date.now() - killedAt).toBeLessThanOrEqual(CONFIGURATION.orphanTimeoutMs + 10_000);
      } finally {
        // The held CLI must not outlive this test after its coordinator is killed.
        held.child.kill('SIGKILL');
      }
    },
    TEST_TIMEOUT_MS,
  );
});
