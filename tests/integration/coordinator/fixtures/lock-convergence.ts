import fs, { renameSync, writeFileSync } from 'node:fs';
import { probeProcessIncarnation } from '#src/infra/node-process.js';
import { updateLaunchStatus } from '#src/infra/launch-status.js';
import { SupervisorLaunchMemory } from '#src/coordinator-launch/state.js';
import { replacementServing } from '#src/coordinator-launch/health.js';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { currentLaunchStatus } from '#src/infra/launch-status.js';
import { attemptExclusiveFileLockSync, tryAcquireDiagnosticDirectoryLock } from '#src/infra/fs-lock.js';
import { supervisorLockPath } from '#src/infra/path/index.js';
import childProcess, { type SpawnOptions } from 'node:child_process';
import { runNamespaceSupervisor } from '#src/coordinator-launch/supervisor.js';
import { acquireLaunchOwnership } from '#src/coordinator-launch/ownership.js';
import { selectNextCandidate } from '#src/coordinator-launch/candidate-selection.js';
import { validatedExecutable } from '#src/coordinator-launch/executable.js';

const [mode, executable, runDir, ...alternatives] = process.argv.slice(2);
const manifest = validatedExecutable(executable);
if (manifest === null) throw new Error('Fixture manifest unavailable');
const nativeSpawn = childProcess.spawn;
const children: { child: childProcess.ChildProcess; closed: Promise<void> }[] = [];
const pids: { pid: number; incarnation: string | null; exited: boolean; processGroup: number | null }[] = [];
function publishCreatedPids(): void {
  const path = join(runDir, 'fixture-pids.json');
  writeFileSync(`${path}.tmp`, JSON.stringify(pids));
  renameSync(`${path}.tmp`, path);
}
function track(child: childProcess.ChildProcess, processGroup: number | null = null): childProcess.ChildProcess {
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
  children.push({ child, closed });
  if (child.pid !== undefined) {
    const entry = {
      pid: child.pid,
      incarnation: probeProcessIncarnation(child.pid),
      exited: false,
      processGroup,
    };
    pids.push(entry);
    publishCreatedPids();
    child.once('exit', () => {
      entry.exited = true;
      publishCreatedPids();
    });
  }
  return child;
}
childProcess.spawn = ((command: string, args: readonly string[], options: SpawnOptions) => {
  const child = nativeSpawn(command, args, { ...options, detached: process.platform === 'linux' });
  return track(child, process.platform === 'linux' ? (child.pid ?? null) : null);
}) as typeof nativeSpawn;
syncBuiltinESMExports();
async function cleanupChildren(): Promise<void> {
  await Promise.all(
    children.map(async ({ child, closed }) => {
      if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return closed;
      child.kill('SIGTERM');
      const kill = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }, 1_000);
      try {
        await closed;
      } finally {
        clearTimeout(kill);
      }
    }),
  );
}
let forceExit = false;
let obligationProbe: Promise<void> | null = null;

function holdTerminalPublication(field: 'relaunchOutcome' | 'ownershipWaitOutcome'): void {
  const lease = tryAcquireDiagnosticDirectoryLock(join(runDir, 'launch-status.v1.lock'));
  if (lease === null) throw new Error('Fixture diagnostic lock unavailable');
  const poll = setInterval(() => {
    const status = currentLaunchStatus(runDir);
    if (status?.[field]?.supervisorPid !== process.pid || status.publicationFailure === undefined) return;
    clearInterval(poll);
    console.log('terminal-publication-blocked');
    if (field === 'relaunchOutcome') {
      track(
        childProcess.execFile(
          process.execPath,
          [process.argv[1], 'probe-lock', executable, runDir],
          (error, stdout) => {
            console.log(
              error === null && stdout.trim() === 'acquired'
                ? 'namespace-available-before-publication'
                : 'namespace-retained-during-publication',
            );
            if (mode.endsWith('brief')) lease();
          },
        ),
      );
    } else if (mode.endsWith('brief')) lease();
  }, 50);
}

try {
  if (mode === 'publish-successor-hold') {
    updateLaunchStatus(runDir, (status) => ({
      ...status,
      hold: { kind: 'target-indeterminate', requestId: 'successor-request' },
      signalHolds: [
        { launchId: 'successor', pid: process.pid, incarnation: probeProcessIncarnation(process.pid) ?? 'unavailable' },
      ],
    }));
    console.log('successor-hold-published');
  } else if (mode === 'probe-lock') {
    const lock = attemptExclusiveFileLockSync(supervisorLockPath(runDir));
    console.log(lock.kind);
    if (lock.kind === 'acquired') lock.lease();
  } else if (mode.startsWith('launch')) {
    if (mode === 'launch-never-serving') {
      const spawn = childProcess.spawn;
      childProcess.spawn = ((command: string, args: readonly string[], options: SpawnOptions) =>
        spawn(
          command,
          args[0] === executable ? ['-e', 'setInterval(() => {}, 1000)'] : args,
          options,
        )) as unknown as typeof nativeSpawn;
      syncBuiltinESMExports();
    }
    let observing = false;
    const code = await runNamespaceSupervisor(executable, [], runDir, {
      onChild(child) {
        if (mode === 'launch-fail-before-serving') throw new Error('forced fixture failure before serving');
        const timer = setInterval(() => {
          if (observing || child.pid === undefined) return;
          observing = true;
          void replacementServing(runDir, manifest.flavor, child.pid).then((serving) => {
            observing = false;
            if (serving === true) {
              console.log('fresh-supervisor-serving');
              clearInterval(timer);
              child.kill('SIGTERM');
            }
          });
        }, 100);
        child.once('exit', () => clearInterval(timer));
      },
    });
    process.exitCode = code;
  } else if (mode.startsWith('fail')) {
    if (mode === 'fail-interleaved') {
      const authorityLease = SupervisorLaunchMemory.prototype.authorityLease;
      SupervisorLaunchMemory.prototype.authorityLease = function (release) {
        const lease = authorityLease.call(this, release);
        let published = false;
        return () => {
          lease();
          if (!published) {
            published = true;
            childProcess.execFileSync(
              process.execPath,
              [process.argv[1], 'publish-successor-hold', executable, runDir],
              { timeout: 5_000 },
            );
          }
        };
      };
    }
    let unidentified: childProcess.ChildProcess | null = null;
    if (mode === 'fail-unsettled') {
      const read = fs.readFileSync;
      fs.readFileSync = ((...args: Parameters<typeof read>) => {
        if (unidentified?.pid !== undefined && String(args[0]) === `/proc/${unidentified.pid}/stat`)
          throw Object.assign(new Error('fixture identity probe refused'), { code: 'EACCES' });
        return read(...args);
      }) as typeof read;
      const release = SupervisorLaunchMemory.prototype.release;
      let probed = false;
      SupervisorLaunchMemory.prototype.release = function () {
        const settled = release.call(this);
        if (!probed && unidentified !== null && unidentified.exitCode === null && unidentified.signalCode === null) {
          probed = true;
          if (!this.children().some((slot) => slot.phase === 'reserved'))
            throw new Error('Missing real launch reservation');
          console.log(
            settled ? 'release-accepted-live-unidentified-child' : 'release-blocked-by-live-unidentified-child',
          );
          obligationProbe = new Promise<void>((resolve) => {
            setTimeout(() => {
              track(
                childProcess.execFile(
                  process.execPath,
                  [process.argv[1], 'probe-lock', executable, runDir],
                  (error, stdout) => {
                    console.log(
                      error === null && stdout.trim() === 'contended'
                        ? 'ownership-held-with-unsettled-child'
                        : 'ownership-lost-with-unsettled-child',
                    );
                    unidentified?.once('exit', () => {
                      console.log('real-obligation-settled');
                      resolve();
                    });
                    unidentified?.kill('SIGTERM');
                  },
                ),
              );
            }, 50);
          });
        }
        return settled;
      };
    }
    if (mode.startsWith('fail-publication')) {
      const release = SupervisorLaunchMemory.prototype.release;
      let held = false;
      SupervisorLaunchMemory.prototype.release = function () {
        const settled = release.call(this);
        if (settled && !held) {
          held = true;
          holdTerminalPublication('relaunchOutcome');
        }
        return settled;
      };
    }
    if (mode === 'fail-held') {
      const release = SupervisorLaunchMemory.prototype.release;
      let probeStarted = false;
      let ownershipHeld = false;
      SupervisorLaunchMemory.prototype.release = function () {
        if (!probeStarted) {
          probeStarted = true;
          console.log('release-refused');
          setTimeout(() => {
            track(
              childProcess.execFile(
                process.execPath,
                [process.argv[1], 'probe-lock', executable, runDir],
                (error, stdout) => {
                  ownershipHeld = error === null && stdout.trim() === 'contended';
                  console.log(ownershipHeld ? 'ownership-held-while-refused' : 'ownership-lost-while-refused');
                },
              ),
            );
          }, 50);
        }
        if (!ownershipHeld) return false;
        const settled = release.call(this);
        if (settled) console.log('release-settled');
        return settled;
      };
    }
    const eligible = new Set([executable, ...alternatives]);
    const spawn = childProcess.spawn;
    let attempts = 0;
    childProcess.spawn = ((command: string, args: readonly string[], options: SpawnOptions) => {
      const fail = eligible.has(args?.[0]);
      if (fail) {
        attempts += 1;
        console.log(`spawn-failed:${args[0]}`);
        if (mode === 'fail-unsettled' && attempts === 3) {
          unidentified = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], options);
          return unidentified;
        }
      }
      return spawn(fail ? '/missing-coral-test-node' : command, args, options);
    }) as unknown as typeof spawn;
    syncBuiltinESMExports();
    const code = await runNamespaceSupervisor(executable, [], runDir);
    if (mode.startsWith('fail-publication')) forceExit = true;
    process.exitCode = code;
  } else {
    if (mode.startsWith('wait-publication')) holdTerminalPublication('ownershipWaitOutcome');
    if (mode === 'wait-acquire') console.log('wait-started');
    const acquisition = await acquireLaunchOwnership(runDir, executable, manifest);
    if (acquisition.kind === 'finished') {
      if (mode.startsWith('wait-publication')) forceExit = true;
      process.exitCode = acquisition.exitCode;
    } else {
      try {
        if (mode === 'wait-acquire') console.log('ownership-acquired');
        else {
          const selected = await selectNextCandidate({
            ...acquisition,
            runDir,
            original: { executable, buildSetId: manifest.buildSetId },
            originalManifest: manifest,
            tried: new Set(),
            firstLaunch: true,
            unidentifiedBinder: { observed: false },
          });
          if (mode === 'retry' && selected.kind === 'candidate') {
            const next = await selectNextCandidate({
              ...acquisition,
              runDir,
              original: { executable, buildSetId: manifest.buildSetId },
              originalManifest: manifest,
              tried: new Set([selected.candidate.executable]),
              firstLaunch: false,
              unidentifiedBinder: { observed: false },
            });
            console.log(JSON.stringify(next));
          } else console.log(JSON.stringify(selected));
        }
      } finally {
        acquisition.owner.release();
      }
    }
  }
} catch (error: unknown) {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 2;
} finally {
  await Promise.resolve(obligationProbe);
  await cleanupChildren();
}
if (forceExit) process.exit(process.exitCode ?? 0);
