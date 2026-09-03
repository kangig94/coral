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

/**
 * Drives the real backend to a genuine `acquireProviderProxySet` — a real guardian, reaper, and proxy,
 * spawned through the production spawn path — then stops only the coordinator with `SIGSTOP` and reads the
 * guardian/reaper back through their own `*.holder-status.v1` surface while it cannot run at all. Copies
 * `mutate-via-ipc.test.ts`'s own shape closely: a throwaway job runs to completion first (which is what
 * establishes a durably readable operation record at all — a first-and-only operation's record is not
 * observed to become readable on its own), then a second job is the one actually held.
 */

const REPO_ROOT = process.cwd();
const SOURCE_BACKEND_BUNDLE = join(REPO_ROOT, 'clients', 'build', 'coral-backend.cjs');
const SOURCE_CLI_BUNDLE = join(REPO_ROOT, 'clients', 'build', 'coral-cli.cjs');
const SOURCE_CLAUDE_APPSERVER_BUNDLE = join(REPO_ROOT, 'clients', 'build', 'coral-claude-appserver.cjs');
const SOURCE_MANIFEST = join(REPO_ROOT, 'clients', 'build', 'manifest.json');
const SOURCE_SQLITE3_DIR = join(REPO_ROOT, 'node_modules', 'better-sqlite3');

function requireReadableHolderStatusRow(
  row: DirectProviderProxySetHolderStatusRow | undefined,
): DirectProviderProxySetHolderStatus {
  if (row === undefined) throw new Error('provider proxy set holder-status row was absent');
  if ('kind' in row) throw new Error(`provider proxy capsule was unreadable: ${row.path} (${row.reason})`);
  return row;
}

/** The requirement's own acceptance number. Every other timing vector this branch touches runs on injected
 *  time; this is the one place a real wall-clock wait is deliberate. */
const STARVATION_HOLD_MS = 60_000;

const CONFIGURATION = resolveProviderProxyDeadlineConfiguration({ get: (name) => process.env[name] });

/** Round-trip heartbeat evidence already re-anchors the first identity-bound holder check to roughly one
 *  adoption window in the future on every accepted heartbeat (`ControlLeaseEvidence.echoChallenge`), so that
 *  horizon never arrives while the coordinator is healthy — it only fires once heartbeats actually stop,
 *  roughly this many milliseconds into a freeze. The margin covers the probe's own bound and wake latency. */
const ALIVE_CROSSOVER_MS = providerProxyAdoptionWindowMs(CONFIGURATION) + 10_000;

/** Each spawned CLI's own exit-wait is bounded by a watchdog sized to what *that* run is expected to do, not
 *  to the whole test's remaining budget: a watchdog derived from the outer test timeout can never fire before
 *  it, because a CLI launched partway through the test starts counting from its own already-late spawn time,
 *  not from test start. `throwaway` completes and `quick` reaches the provider's own `turn/start` — neither
 *  waits on a parked turn — so both are expected to reach their own outcome in low single-digit seconds. */
const QUICK_CLI_WATCHDOG_MS = 30_000;

/** Named per stage rather than one probed lump sum, so the margin this leaves above the mechanism's own two
 *  timers (the hold and phase two's death bound) is traceable to what actually has to fit inside it: setup
 *  before the freeze (throwaway's own dispatch plus getting the held job parked and its record readable),
 *  the checks made right after resume, and the quick job's own dispatch-and-reach-the-provider watchdog above. */
const PRE_FREEZE_SETUP_MARGIN_MS = 20_000;
const POST_RESUME_MARGIN_MS = 15_000;
const TEST_TIMEOUT_MS =
  PRE_FREEZE_SETUP_MARGIN_MS +
  STARVATION_HOLD_MS +
  POST_RESUME_MARGIN_MS +
  QUICK_CLI_WATCHDOG_MS +
  CONFIGURATION.orphanTimeoutMs +
  10_000;

/** `held` runs from before the freeze through phase two and is always killed explicitly, right after phase
 *  two, regardless of whether it has answered — this watchdog is only a backstop for the case where that kill
 *  is somehow never reached, so it is sized to outlast the outer test timeout itself rather than to any one
 *  of its stages, and must never be the one that fires on a passing run. */
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

// A minimal fake `codex app-server`. `initialize`/`config/read`/`thread/start` all answer immediately. The
// *first* operation's `turn/start` also answers immediately — it exists only to warm up acquisition and
// establish that a durable record exists at all, exactly like `mutate-via-ipc.test.ts`'s own first job. Any
// later operation (`second-operation-armed` present at this process's own startup) parks at `turn/start`
// instead, until the test writes `turn-complete-gate` — that is the held claim the freeze protects.
//
// A shared-lease provider root is reused across operations while one stays attached (only one root may be
// live at a time — `MAX_PROXY_LIVE_PROVIDER_ROOTS`, `provider-root-authority.ts`), so a job dispatched while
// the held job's operation is still attached is routed to *this same* process rather than a fresh one — and
// `secondOperation` was latched at this process's own startup, before that later job even existed, so its
// `turn/start` inherits the same parked behavior. `turn-start-seen-<n>` counts every `turn/start` this process
// receives (parked or not) so a test can prove a *specific later* one arrived without needing it to complete.
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

function signal(name) {
  fs.writeFileSync(path.join(stateDir, name), 'ready');
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
        signal('turn-start-pending');
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
  copyFileSync(SOURCE_MANIFEST, join(root, 'bridge', 'manifest.json'));
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

/** The coordinator's own rendered lifecycle log — `execution-services.ts` wires `reportLifecycle` straight to
 *  `backendLog`, and `backend-log.ts` sends every line to this process's stderr, which delegated startup
 *  (`ensure.ts`) redirects here rather than discarding it. */
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
  // This process may itself be running as a Coral child (a delegated job/session); that identity must not
  // leak into the CLI this test spawns, which needs to start its own.
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
      // Freezing the real backend for 60s also freezes its KB daemon supervisor, Journal, and consumer
      // drivers; none of that is this test's subject, and starving it too would only add unrelated flakiness.
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
    // `watchdogMs` is this run's own bound, chosen by its caller for what this particular CLI is expected to
    // do — never the outer test timeout, which would let this fire *after* vitest's own bound for any CLI
    // launched partway through the test and so never fire at all in practice, surfacing a generic outer
    // timeout instead of this dump.
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

/** `/proc/<pid>/status` stays readable while a process is stopped, and `State:` carries `T` for exactly that
 *  state (the same fact `status.integration.test.ts`'s `waitForStopped` relies on) — asserted directly rather
 *  than inferred from a busy-wait's own timing. */
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
      // Diagnostic only: names which stage this run reached, not a claim any reader should trust once this
      // test is passing reliably — delete once the coupled-watchdog bug this was added to chase is confirmed
      // fixed by a real run.
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

      // Throwaway: establishes the provider-proxy set (acquisition, three real roles) and completes
      // immediately. Nothing below reads *this* job's record — `mutate-via-ipc.test.ts` shows a completed
      // job's record is deleted, so a `null` read for `throwawayJobId` after this point is expected, not a
      // failure, which is exactly why nothing looks for it again.
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

      // Held: the second operation, parked at `turn/start` until the test releases it — the live claim the
      // freeze protects. Every read from here to phase two names `heldJobId`, never the throwaway's.
      writeFileSync(join(fixture.fakeStateDir, 'second-operation-armed'), 'armed');
      const heldPromptPath = join(fixture.projectRoot, 'held-prompt.txt');
      writeFileSync(heldPromptPath, 'exercise a coordinator starved for 60 seconds', 'utf-8');

      const held = startCli(fixture, heldPromptPath, HELD_CLI_WATCHDOG_MS);
      mark('held launched');
      try {
        await waitForCliGate(held, () => launchedJobId(held.stdout()) !== null, 'held job launch');
        const heldJobId = launchedJobId(held.stdout());
        if (heldJobId === null) throw new Error('held CLI never reported its provider job id');

        // Parked at `turn/start`, not `thread/start`: the coordinator has sent `turn/start` to the fake codex
        // and is waiting on its answer, which is exactly the durable "executing" claim this branch protects —
        // and the fake codex will not answer until the gate below is written, well after the freeze.
        await waitForCliGate(
          held,
          () => existsSync(join(fixture.fakeStateDir, 'turn-start-pending')),
          'turn/start gate',
        );
        mark('held parked at turn/start');
        // Only this held job's fake-codex process reads `second-operation-armed`, and only at its own
        // startup, which already happened above — clearing the marker now cannot affect it, and is what lets
        // the *next* (quick, post-resume) job complete immediately like the throwaway did instead of also
        // parking on the same shared gate file.
        rmSync(join(fixture.fakeStateDir, 'second-operation-armed'), { force: true });

        // Split so a failure names which of two different things did not happen. The precedent's own second
        // (warm-set) operation needs an explicit wait for the record to exist at all before it ever checks a
        // phase — kept here as the better diagnostic even though the set is warm by this point too.
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

        // Four distinct, independently signalable real OS processes — never one process answering for another.
        const targetPids = {
          coordinator: coordinatorPid,
          guardian: guardian.pid,
          reaper: reaper.pid,
          proxy: proxy.pid,
        };
        expect(new Set(Object.values(targetPids)).size).toBe(4);
        expect(Object.values(targetPids).every((pid) => observeProcessLiveness(pid) === 'alive')).toBe(true);

        const runtime = createRealRuntime(fixture.flavor, { baseDir: join(fixture.home, '.coral') });

        // `install()` (holder-lifecycle.ts) seeds a holder as `unobservable`, and round-trip heartbeat
        // evidence keeps re-anchoring the first identity-bound check into the future for as long as the
        // coordinator stays healthy (see `ALIVE_CROSSOVER_MS`) — so `unobservable` is the honest, expected
        // reading here, not a failure. `phase` separates "never published" from "published, not yet observed":
        // only the latter is what this baseline should show.
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
            // A pid-targeted `SIGSTOP`, never a group signal: the guardian is spawned detached into its own
            // group specifically so the enforcers keep running while the coordinator cannot — checked, not
            // assumed, by confirming it never enters the same `T` state the coordinator is in right now.
            expect(isStoppedOnLinux(guardian.pid)).toBe(false);
            expect(isStoppedOnLinux(reaper.pid)).toBe(false);
            const readings = await readProviderProxySetHolderStatusDirect(runtime);
            latestReadings = readings;
            expect(readings).toHaveLength(1);
            const set = requireReadableHolderStatusRow(readings[0]);
            const elapsed = Date.now() - holdStart;
            for (const role of ['guardian', 'reaper'] as const) {
              const reading = set[role];
              // `departed` must never appear at any point: this branch's whole design turns on absence never
              // being read from silence — a stopped-but-alive holder answering `departed` here would be the
              // regression this test exists to catch. Before `ALIVE_CROSSOVER_MS`, heartbeats have only just
              // stopped and no observation may have run yet, so `unobservable` is still an honest answer; from
              // `ALIVE_CROSSOVER_MS` on, the identity-bound observation must have run and found the holder
              // genuinely alive, so only `alive` is acceptable.
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
          // Proves the polling loop actually ran more than once during the freeze rather than the hold having
          // finished before the loop's first real wait — the loop condition alone cannot distinguish those.
          expect(observations).toBeGreaterThan(1);
          // The loop's own condition stops polling once a further 5s sleep would overshoot the bound, so its
          // last iteration — and the reading captured in `latestReadings`, used below — lands at most one poll
          // interval before this point, not at the freeze's true boundary. Sleep out whatever the loop itself
          // did not spend, so the coordinator is actually stopped for the requirement's full 60s rather than
          // one poll interval short of it.
          const remainingHoldMs = STARVATION_HOLD_MS - (Date.now() - holdStart);
          if (remainingHoldMs > 0) await new Promise((resolve) => setTimeout(resolve, remainingHoldMs));
          expect(Date.now() - holdStart).toBeGreaterThanOrEqual(STARVATION_HOLD_MS);
          mark('hold complete');
        } finally {
          // Unconditional: a failed assertion above must not leave a stopped coordinator behind for the next
          // test, or for a developer's own shell, to inherit.
          process.kill(coordinatorPid, 'SIGCONT');
          mark('SIGCONT sent');
        }
        await waitForCondition(() => !isStoppedOnLinux(coordinatorPid), 5_000);
        mark('resume confirmed');

        // The positive control this test turns on: a build where the identity-bound observation never runs
        // stays `unobservable` at the sequence it was seeded with, forever — indistinguishable, on disposition
        // alone, from a healthy coordinator that simply has not been silent for long enough yet. Only the
        // sequence advancing by exactly one, during the freeze, proves an observation actually happened and
        // found the holder alive rather than never running at all.
        const latestSet = requireReadableHolderStatusRow(latestReadings?.[0]);
        const guardianAfterHold = latestSet.guardian;
        const reaperAfterHold = latestSet.reaper;
        expect(guardianAfterHold?.kind === 'answered' ? guardianAfterHold.status.transitionSequence : null).toBe(
          baselineSequence.guardian === null ? null : baselineSequence.guardian + 1,
        );
        expect(reaperAfterHold?.kind === 'answered' ? reaperAfterHold.status.transitionSequence : null).toBe(
          baselineSequence.reaper === null ? null : baselineSequence.reaper + 1,
        );

        // Same two answers after resume, at the same advanced sequence — nothing this process could not see
        // during the freeze happened to it either.
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

        // `#beginContainment` never entered: no rendered decision line reached the coordinator's own log.
        const coordinatorLog = readFileSync(coordinatorLogPath(fixture), 'utf-8');
        expect(coordinatorLog).not.toContain('action=stop-and-reap');
        expect(coordinatorLog).not.toContain('action=await-containment-absence');

        // Route survival, proven as a round trip rather than a read: dispatch a third job and confirm the
        // coordinator accepts it and routes it through the *same* discovered set, reaching the provider's own
        // `turn/start` — without waiting for that turn to finish. It cannot finish: only one provider root may
        // be live at a time (`MAX_PROXY_LIVE_PROVIDER_ROOTS`, `provider-root-authority.ts`), the held
        // operation is still attached to it, so this job is routed to the very app-server process already
        // parked on `turn-complete-gate` for the held job's own turn. Proving the route survives is exactly as
        // far as this can honestly go without releasing the held claim phase two still needs below.
        const quickPromptPath = join(fixture.projectRoot, 'quick-prompt.txt');
        writeFileSync(quickPromptPath, 'prove the route survives without freeing the held turn', 'utf-8');
        const quick = startCli(fixture, quickPromptPath, QUICK_CLI_WATCHDOG_MS);
        mark('quick job launched');
        await waitForCliGate(quick, () => launchedJobId(quick.stdout()) !== null, 'quick job launch');
        // The held job's own turn/start was this shared root's first; a second is only reachable if the
        // coordinator actually admitted and routed *this* job onto the same live set, not a fresh one.
        await waitForCliGate(
          quick,
          () => existsSync(join(fixture.fakeStateDir, 'turn-start-seen-2')),
          'quick reaching the provider through the surviving route',
        );
        mark('quick reached turn/start on the surviving route');
        // Never awaited to completion: it cannot complete while the held turn holds the only live root, and
        // this test does not characterize what a CLI does when its own job can never finish — only that it
        // got as far as the provider. Killed now rather than left running: nothing later needs it alive.
        quick.child.kill('SIGKILL');
        // Still exactly one discoverable set: a fresh acquisition for the quick job — the signature of a route
        // that had actually been removed — would show up here as a second capsule.
        expect(await readProviderProxySetHolderStatusDirect(runtime)).toHaveLength(1);

        // The held claim (`heldJobId`) is untouched by any of the above — still the same live operation phase
        // two is about to reap, never released to make room for the routability proof above.
        const heldAfterResume = readDurableOperation(fixture, heldJobId);
        if (heldAfterResume === null || heldAfterResume.phase !== 'executing') {
          throw new Error(`held operation for ${heldJobId} did not survive the freeze at 'executing'`);
        }

        // Phase two: the coordinator is not merely unresponsive now, it is gone — and the same set, holding
        // the same live claim (`heldJobId`), against the same guardian, must still reach containment absence
        // within its own death bound. A build where the tick never runs fails here even though it passed
        // every assertion above; a build where the deadline still pronounces on elapsed time would have
        // already failed above.
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
        // The held CLI (`held`) is parked awaiting a job answer from a coordinator that phase two just
        // killed. Nothing above or below this point awaits `held.completed` — a CLI whose coordinator died out
        // from under it has no bounded, well-defined exit behavior this test may rely on, so this test does
        // not try to characterize one. It is only ever killed, never awaited: safe unconditionally, since
        // killing an already-exited process is a no-op.
        //
        // Its fake-codex `app-server` process needs no separate signal either: `spawnProviderServerProcess`
        // does not spawn it `detached`, so it shares the proxy role's own process group rather than getting
        // one of its own (the proxy is spawned `detached: true` and is that group's leader — see
        // `role-spawn.ts`/`acquisition-steps.ts`). `reapRecordedContainment`'s own escalation signals
        // `-processGroupId` (`process-containment.ts`), which reaches it as part of reaping the proxy — this
        // test does not depend on the held CLI process to have gone away for that to happen.
        held.child.kill('SIGKILL');
      }
    },
    TEST_TIMEOUT_MS,
  );
});
