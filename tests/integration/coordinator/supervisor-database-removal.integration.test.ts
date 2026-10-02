import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import * as nodeFs from 'node:fs';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';

import { CURRENT_STRICT_BUNDLE_MANIFEST_FILE } from '#src/infra/bundle-manifest-address.js';
import {
  launchAdmissionPath,
  listLaunchAdmissions,
  listLaunchSubjects,
  readLaunchAdmission,
} from '#src/infra/launch-admission-record.js';
import { readLaunchStatus, updateLaunchStatus } from '#src/infra/launch-status.js';
import { probeProcessIncarnation } from '#src/infra/node-process.js';
import { readUpgradeIntent } from '#src/infra/upgrade-intent.js';
import { coordinatorPaths } from '#src/infra/path/coordinator.js';
import { requestIpcMethod } from '#src/transport/ipc/client.js';
import { attemptExclusiveFileLockSync } from '#src/infra/fs-lock.js';
import {
  createPluginFixture,
  readDiscoveryRecordForHome,
  storeDbPathForHome,
  waitForDiscoveryRecord,
} from '#tests/integration/coordinator/helpers.js';
import { getBackendStatusFull } from '#src/cli/backend-status.js';
import { formatBackendStatus } from '#src/cli/format/backend.js';
import { SupervisorEvidence } from '#tests/support/supervisor-evidence.js';
import { waitForCondition } from '#tests/support/wait-for-condition.js';
import { freezeRecordedProcesses, stopRecordedProcesses } from '#tests/support/stop-recorded-processes.js';

vi.mock('node:fs', async (importOriginal) => ({ ...(await importOriginal<typeof nodeFs>()) }));

function buildSetId(root: string): string {
  const manifest = JSON.parse(readFileSync(join(root, 'bridge', CURRENT_STRICT_BUNDLE_MANIFEST_FILE), 'utf8')) as {
    buildSetId: string;
  };
  return manifest.buildSetId;
}

async function stopFixtureProcesses(
  supervisors: ChildProcess[],
  identities: Map<number, string>,
  timeoutMs = 5_000,
): Promise<void> {
  const recorded = [...identities].map(([pid, incarnation]) => ({ pid, incarnation }));
  freezeRecordedProcesses(recorded);
  for (const supervisor of supervisors) supervisor.kill('SIGKILL');
  await stopRecordedProcesses(recorded, 'SIGKILL', timeoutMs);
  await waitForCondition(
    () => supervisors.every((supervisor) => supervisor.exitCode !== null || supervisor.signalCode !== null),
    timeoutMs,
  );
}

it.runIf(process.platform === 'linux')('waits for every recorded fixture writer before removing its root', async () => {
  const supervisor = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
  const writer = spawn(process.execPath, ['-e', 'process.send("ready"); setInterval(() => {}, 1000)'], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  let ready = false;
  writer.on('message', () => {
    ready = true;
  });
  const kill = process.kill;
  let delayedKill: ReturnType<typeof setTimeout> | undefined;
  try {
    await waitForCondition(() => ready, 5_000);
    const pid = writer.pid!;
    const incarnation = probeProcessIncarnation(pid);
    if (incarnation === null) throw new Error('Fixture writer identity is unavailable');
    vi.spyOn(process, 'kill').mockImplementation((target, signal) => {
      if (target !== pid || signal !== 'SIGKILL') return kill(target, signal);
      delayedKill ??= setTimeout(() => kill(target, signal), 100);
      return true;
    });
    await stopFixtureProcesses([supervisor], new Map([[pid, incarnation]]));
    expect(probeProcessIncarnation(pid)).not.toBe(incarnation);
  } finally {
    clearTimeout(delayedKill);
    vi.restoreAllMocks();
    supervisor.kill('SIGKILL');
    writer.kill('SIGKILL');
    await waitForCondition(() => writer.signalCode !== null && supervisor.signalCode !== null, 5_000);
  }
});

it.runIf(process.platform === 'linux').each(['recovers', 'stays unknown'] as const)(
  'preserves a writer root while its incarnation probe %s',
  async (observation) => {
    const root = mkdtempSync(join(tmpdir(), 'coral-teardown-unknown-'));
    const writer = spawn(
      process.execPath,
      [
        '-e',
        `const fs = require('node:fs'); process.on('message', () => { fs.mkdirSync(process.argv[1], { recursive: true }); fs.writeFileSync(process.argv[1] + '/late-write', 'live'); process.send('wrote'); }); process.send('ready'); setInterval(() => {}, 1000);`,
        root,
      ],
      { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
    );
    let ready = false;
    let wrote = false;
    writer.on('message', (message) => {
      if (message === 'ready') ready = true;
      if (message === 'wrote') wrote = true;
    });
    const read = nodeFs.readFileSync;
    try {
      await waitForCondition(() => ready, 5_000);
      const pid = writer.pid!;
      const incarnation = probeProcessIncarnation(pid);
      if (incarnation === null) throw new Error('Fixture writer identity is unavailable');
      let failedReads = 0;
      const fault = vi.spyOn(nodeFs, 'readFileSync').mockImplementation((...args) => {
        if (String(args[0]) === `/proc/${pid}/stat` && (observation === 'stays unknown' || failedReads < 3)) {
          failedReads++;
          throw Object.assign(new Error('Transient proc observation failure'), { code: 'EIO' });
        }
        return read(...args);
      });
      const timeoutMs = observation === 'recovers' ? 5_000 : 250;
      const stopped = stopFixtureProcesses([], new Map([[pid, incarnation]]), timeoutMs).then(() => {
        rmSync(root, { recursive: true, force: true });
      });
      if (observation === 'recovers') {
        await stopped;
        expect(existsSync(root)).toBe(false);
      } else {
        await expect(stopped).rejects.toThrow(`Fixture process departure unproven after 250ms: ${pid}`);
        expect(existsSync(root)).toBe(true);
        fault.mockRestore();
        expect(probeProcessIncarnation(pid)).toBe(incarnation);
        writer.send('write');
        await waitForCondition(() => wrote, 5_000);
        expect(readFileSync(join(root, 'late-write'), 'utf8')).toBe('live');
      }
      expect(failedReads).toBeGreaterThanOrEqual(3);
    } finally {
      vi.restoreAllMocks();
      writer.kill('SIGKILL');
      await waitForCondition(() => writer.signalCode !== null, 5_000);
      rmSync(root, { recursive: true, force: true });
    }
  },
);

describe.runIf(process.platform === 'linux')('supervisor database removal recovery', () => {
  it.each([false, true])(
    'recovers a stopped direct child after transient unknown evidence under retained lock authority (resumed: %s)',
    async (resumed) => {
      const roots: string[] = [];
      const home = mkdtempSync(join(tmpdir(), 'coral-retirement-evidence-retry-'));
      roots.push(home);
      const fixture = createPluginFixture(roots, { flavor: 'prod', version: '0.10.14' });
      const runDir = coordinatorPaths('prod', { baseDir: join(home, '.coral') }).runDir;
      const marker = join(home, 'unknown.json');
      const harness = join(home, 'supervisor.mjs');
      await build({
        entryPoints: [fileURLToPath(new URL('./fixtures/namespace-supervisor-harness.ts', import.meta.url))],
        outfile: harness,
        bundle: true,
        platform: 'node',
        format: 'esm',
        external: ['node:*'],
        plugins: [
          {
            name: 'transient-retirement-observation',
            setup(builder) {
              builder.onLoad({ filter: /\/coordinator-launch\/child-watch\.ts$/ }, ({ path }) => ({
                contents:
                  `import { writeFileSync as fixtureWrite } from 'node:fs';\n` +
                  readFileSync(path, 'utf8')
                    .replace(
                      'state.wedged = true;',
                      `state.wedged = true;
              if (process.env.CORAL_FIXTURE_UNKNOWN_UNTIL === undefined) {
                process.env.CORAL_FIXTURE_UNKNOWN_PID = String(identity.pid);
                process.env.CORAL_FIXTURE_UNKNOWN_UNTIL = String(Date.now() + 1000);
                fixtureWrite(process.env.CORAL_FIXTURE_UNKNOWN_MARKER!, JSON.stringify(identity));
              }`,
                    )
                    .replace(
                      'state.outstanding = null;\n      state.lastAnswer = Date.now();',
                      `state.outstanding = null;
              state.lastAnswer = Date.now();
              process.send?.({ kind: 'fixture-heartbeat-ready' });`,
                    ),
                loader: 'ts',
              }));
              builder.onLoad({ filter: /\/infra\/node-process\.ts$/ }, ({ path }) => ({
                contents: readFileSync(path, 'utf8').replace(
                  'export function probeProcessIncarnation(pid: number, platform = process.platform): ProcessIncarnation | null {',
                  `export function probeProcessIncarnation(pid: number, platform = process.platform): ProcessIncarnation | null {
                if (pid === Number(process.env.CORAL_FIXTURE_UNKNOWN_PID) && Date.now() < Number(process.env.CORAL_FIXTURE_UNKNOWN_UNTIL)) return null;`,
                ),
                loader: 'ts',
              }));
            },
          },
        ],
      });
      const supervisor = spawn(process.execPath, [harness, join(fixture.root, 'bridge', 'coral-backend.cjs')], {
        env: {
          ...process.env,
          HOME: home,
          TMPDIR: home,
          CORAL_SENTINEL_RUN_DIR: runDir,
          CORAL_FIXTURE_REAL_BACKEND: '1',
          CORAL_FIXTURE_UNKNOWN_MARKER: marker,
        },
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      });
      let heartbeatReady = false;
      supervisor.on('message', (message: unknown) => {
        if (
          typeof message === 'object' &&
          message !== null &&
          'kind' in message &&
          message.kind === 'fixture-heartbeat-ready'
        )
          heartbeatReady = true;
      });
      const evidence = new SupervisorEvidence(runDir);
      let first: { pid: number; incarnation?: string } | undefined;
      try {
        first = await waitForDiscoveryRecord(home, 'prod', 15_000);
        await waitForCondition(() => evidence.memory()?.launch?.phase === 'serving', 5_000);
        await waitForCondition(() => heartbeatReady, 5_000);
        const inode = statSync(coordinatorPaths('prod', { baseDir: join(home, '.coral') }).supervisorLockFile);
        const admittedAt = evidence.memory()?.launch?.admittedAt;
        if (admittedAt === undefined) throw new Error('Fixture admission time is unavailable');
        const originalAdmissionDeadline = admittedAt + 25_000;
        process.kill(first.pid, 'SIGSTOP');
        await waitForCondition(() => existsSync(marker), Math.max(1, originalAdmissionDeadline - Date.now()));
        expect(evidence.lockHolder()?.pid).toBe(supervisor.pid);
        expect(evidence.memory()?.launch?.terminationAt).toBeUndefined();
        await waitForCondition(() => {
          const status = readLaunchStatus(runDir);
          return status.kind === 'readable' && status.status.signalHolds.some((hold) => hold.pid === first!.pid);
        }, 800);
        if (resumed) {
          process.kill(first.pid, 'SIGCONT');
          await waitForCondition(() => {
            const status = readLaunchStatus(runDir);
            return status.kind === 'readable' && !status.status.signalHolds.some((hold) => hold.pid === first!.pid);
          }, 5_000);
          expect(probeProcessIncarnation(first.pid)).toBe(first.incarnation);
          expect(evidence.memory()?.launch?.terminationAt).toBeUndefined();
          await waitForCondition(() => evidence.memory()?.owner.mode === 'supervised', 3_000);
        } else await waitForCondition(() => probeProcessIncarnation(first!.pid) === null, 5_000);
        expect(evidence.lockHolder()?.pid).toBe(supervisor.pid);
        const retained = statSync(coordinatorPaths('prod', { baseDir: join(home, '.coral') }).supervisorLockFile);
        expect({ dev: retained.dev, ino: retained.ino }).toEqual({ dev: inode.dev, ino: inode.ino });
        expect(Date.now()).toBeLessThan(originalAdmissionDeadline);
      } finally {
        const survivors = listLaunchAdmissions(runDir);
        const identities = new Map<number, string>();
        for (const entry of survivors) {
          if (entry.kind === 'readable' && entry.admission.child.incarnation !== null)
            identities.set(entry.admission.child.pid, entry.admission.child.incarnation);
        }
        if (first?.incarnation !== undefined) identities.set(first.pid, first.incarnation);
        await stopFixtureProcesses([supervisor], identities);
        for (const root of roots) rmSync(root, { recursive: true, force: true });
      }
    },
    35_000,
  );

  it.each([
    'permanent parent freeze',
    'initially unknown parent then permanent freeze',
    'discovery overlap',
    'unverifiable parent',
    'serving successor upgrade',
  ] as const)(
    'preserves kernel-lock authority after %s',
    async (fault) => {
      const roots: string[] = [];
      const home = mkdtempSync(join(tmpdir(), 'coral-supervisor-db-removal-'));
      roots.push(home);
      const original = createPluginFixture(roots, {
        flavor: 'prod',
        version: '0.10.14',
        backend: fault === 'unverifiable parent' ? 'supervisor-signal-refusal' : 'supervisor-silence',
        accepts: 'bundled',
      });
      const target =
        fault === 'discovery overlap' || fault === 'serving successor upgrade' || fault === 'unverifiable parent'
          ? createPluginFixture(roots, {
              flavor: 'prod',
              version: '0.10.15',
              backend: 'supervisor-silence',
              accepts: 'bundled',
            })
          : original;
      const finalTarget =
        fault === 'serving successor upgrade'
          ? createPluginFixture(roots, {
              flavor: 'prod',
              version: '0.10.16',
              backend: 'supervisor-silence',
              accepts: 'bundled',
            })
          : target;
      const targetBuild = buildSetId(target.root);
      const finalBuild = buildSetId(finalTarget.root);
      const runDir = coordinatorPaths('prod', { baseDir: join(home, '.coral') }).runDir;
      const harness = join(home, 'supervisor.mjs');
      await build({
        entryPoints: [fileURLToPath(new URL('./fixtures/namespace-supervisor-harness.ts', import.meta.url))],
        outfile: harness,
        bundle: true,
        platform: 'node',
        target: 'node22',
        format: 'esm',
        external: ['node:*'],
      });
      const supervisor = spawn(process.execPath, [harness, join(original.root, 'bridge', 'coral-backend.cjs')], {
        env: {
          ...process.env,
          HOME: home,
          TMPDIR: home,
          CORAL_SENTINEL_RUN_DIR: runDir,
          CORAL_FIXTURE_REAL_BACKEND: '1',
          CORAL_FIXTURE_INITIAL_PARENT_UNKNOWN: fault === 'initially unknown parent then permanent freeze' ? '1' : '0',
          CORAL_TEST_SUCCESSION_RELEASE_DELAY_MS: '10000',
        },
        stdio: 'ignore',
      });
      const evidence = new SupervisorEvidence(runDir);
      const identities = new Map<number, string>();
      const remember = (): void => {
        const state = evidence.read();
        for (const identity of [state.owner?.process, state.launch?.child, state.attempt?.child]) {
          if (identity !== undefined && identity.incarnation !== null)
            identities.set(identity.pid, identity.incarnation);
        }
      };
      try {
        await waitForCondition(() => {
          remember();
          return evidence.read().launch?.phase === 'serving';
        }, 20_000);
        const first = evidence.read().launch;
        if (first === null || first === undefined) throw new Error('Original child is unavailable');
        const startedAt = Date.now();
        if (fault === 'discovery overlap' || fault === 'serving successor upgrade') {
          // B publishes before A finishes releasing incumbency; both must survive discovery replacement.
          await evidence.request(join(target.root, 'bridge', 'coral-backend.cjs'), targetBuild);
          await waitForCondition(() => {
            remember();
            return evidence.read().attempt?.phase === 'serving';
          }, 20_000);
          expect(readLaunchAdmission(runDir, first.id)).toMatchObject({
            kind: 'readable',
            admission: { child: first.child },
          });
          const second = evidence.read().attempt;
          if (second === null) throw new Error('Successor is unavailable');
          expect(readLaunchAdmission(runDir, second.id)).toMatchObject({
            kind: 'readable',
            admission: { child: second.child },
          });
          if (fault === 'serving successor upgrade')
            await evidence.request(join(finalTarget.root, 'bridge', 'coral-backend.cjs'), finalBuild);
          else {
            process.kill(first.child.pid, 'SIGSTOP');
            supervisor.kill('SIGKILL');
          }
        } else {
          supervisor.kill('SIGSTOP');
        }
        if (fault === 'unverifiable parent') {
          const held = (): boolean => {
            const status = readLaunchStatus(runDir);
            return (
              status.kind === 'readable' &&
              status.status.signalHolds.some((hold) => hold.launchId === `parent:${supervisor.pid}`)
            );
          };
          await waitForCondition(held, 5_000);
          writeFileSync(join(runDir, 'launch-status.v1.json'), '{');
          updateLaunchStatus(runDir, (status) => ({ ...status, signalHolds: [] }));
          expect(readLaunchStatus(runDir)).toMatchObject({
            kind: 'readable',
            status: { previousStatus: 'unavailable' },
          });
          await waitForCondition(held, 2_000);
          expect(evidence.lockHolder()?.pid).toBe(supervisor.pid);
          const inode = statSync(join(runDir, 'namespace-supervisor.v1.lock')).ino;
          await evidence.request(join(target.root, 'bridge', 'coral-backend.cjs'), targetBuild);
          await new Promise((resolve) => setTimeout(resolve, 2_000));
          vi.stubEnv('HOME', home);
          vi.stubEnv('TMPDIR', home);
          const status = await getBackendStatusFull(original.root);
          expect(status.status).toBe('ok');
          expect(formatBackendStatus(status, { kind: 'absent' }, null)).toContain('parent-silent');
          expect(statSync(join(runDir, 'namespace-supervisor.v1.lock')).ino).toBe(inode);
          expect(evidence.lockHolder()?.pid).toBe(supervisor.pid);
          expect(readUpgradeIntent(runDir)).toMatchObject({ kind: 'readable', intent: { disposition: 'pending' } });
          expect(supervisor.signalCode).toBeNull();
          return;
        }
        await waitForCondition(
          () => {
            remember();
            const owner = evidence.read().owner;
            return (
              owner !== null &&
              (fault === 'serving successor upgrade'
                ? owner.process.pid === supervisor.pid
                : owner.process.pid !== supervisor.pid) &&
              evidence.lockHolder()?.pid === owner.process.pid
            );
          },
          fault.includes('freeze') ? 5_000 : 15_000,
        );
        await waitForCondition(() => {
          remember();
          const state = evidence.read();
          return (
            state.launch?.phase === 'serving' &&
            state.launch.child.pid !== first.child.pid &&
            state.launch.buildSetId === finalBuild &&
            state.launch.parent.pid === state.owner?.process.pid &&
            state.owner.mode === 'supervised'
          );
        }, 30_000);
        expect(Date.now() - startedAt).toBeLessThan(45_000);
        expect(evidence.lockHolder()?.pid).toBe(evidence.read().owner?.process.pid);
        expect(probeProcessIncarnation(first.child.pid)).not.toBe(first.child.incarnation);
        if (fault !== 'serving successor upgrade') expect(supervisor.signalCode).toBe('SIGKILL');
      } catch (error) {
        throw new Error(
          `Database removal recovery failed (${fault}): state=${JSON.stringify(evidence.read())}; intent=${JSON.stringify(readUpgradeIntent(runDir))}; status=${JSON.stringify(readLaunchStatus(runDir))}`,
          { cause: error },
        );
      } finally {
        vi.unstubAllEnvs();
        remember();
        await stopFixtureProcesses([supervisor], identities);
        for (const root of roots.reverse()) rmSync(root, { recursive: true, force: true });
      }
    },
    70_000,
  );
});

it.each(['creation', 'acquisition', 'repair'] as const)(
  'holds and retries %s observation failure while an independent namespace boots and serves',
  async (fault) => {
    const roots: string[] = [];
    const home = mkdtempSync(join(tmpdir(), 'coral-lock-observation-'));
    const otherHome = mkdtempSync(join(tmpdir(), 'coral-lock-independent-'));
    roots.push(home, otherHome);
    const fixture = createPluginFixture(roots, { flavor: 'prod', version: '0.10.14' });
    const runDir = coordinatorPaths('prod', { baseDir: join(home, '.coral') }).runDir;
    mkdirSync(runDir, { recursive: true });
    const lockPath = join(runDir, 'namespace-supervisor.v1.lock');
    if (fault === 'repair') writeFileSync(lockPath, 'malformed SQLite bytes that no process can hold');
    const inode = fault === 'repair' ? statSync(lockPath).ino : undefined;
    const marker = join(home, 'storage-fault');
    writeFileSync(marker, 'hold');
    const harness = join(home, 'supervisor.mjs');
    await build({
      entryPoints: [fileURLToPath(new URL('./fixtures/namespace-supervisor-harness.ts', import.meta.url))],
      outfile: harness,
      bundle: true,
      platform: 'node',
      format: 'esm',
      external: ['node:*'],
      plugins: [
        {
          name: 'lock-storage-observation',
          setup(builder) {
            builder.onLoad({ filter: /\/infra\/fs-lock\.ts$/ }, ({ path }) => {
              const signatures = {
                creation: 'export function createSharedFileLockSync(path: string): FileLockLease {',
                acquisition:
                  'export function attemptExclusiveFileLockSync(path: string, busyTimeoutMs = 0): ExclusiveFileLockAttempt {',
                repair: 'export function repairMalformedFileLockSync(path: string): MalformedFileLockRepair {',
              };
              const refusal =
                fault === 'creation'
                  ? "throw new Error('fixture EACCES: lock creation');"
                  : "return { kind: 'unobservable', cause: new Error('fixture EACCES: lock observation') };";
              const original = readFileSync(path, 'utf8');
              const contents = original.replace(
                signatures[fault],
                `${signatures[fault]}
              if (path === process.env.CORAL_FIXTURE_LOCK_ADDRESS) {
                let held = false;
                try { held = readFileSync(process.env.CORAL_FIXTURE_STORAGE_FAULT!, 'utf8') === 'hold'; } catch {}
                if (held) { ${refusal} }
              }`,
              );
              if (contents === original) throw new Error('Missing lock fault target');
              return { contents, loader: 'ts' };
            });
          },
        },
      ],
    });
    const supervisors: ReturnType<typeof spawn>[] = [];
    const children: { pid: number; incarnation?: string }[] = [];
    const start = (root: string) => {
      const supervisor = spawn(process.execPath, [harness, join(fixture.root, 'bridge', 'coral-backend.cjs')], {
        env: {
          ...process.env,
          HOME: root,
          TMPDIR: root,
          CORAL_SENTINEL_RUN_DIR: coordinatorPaths('prod', { baseDir: join(root, '.coral') }).runDir,
          CORAL_FIXTURE_REAL_BACKEND: '1',
          CORAL_FIXTURE_LOCK_ADDRESS: lockPath,
          CORAL_FIXTURE_STORAGE_FAULT: marker,
        },
        stdio: 'ignore',
      });
      supervisors.push(supervisor);
      return supervisor;
    };
    try {
      const held = start(home);
      await waitForCondition(() => {
        const status = readLaunchStatus(runDir);
        return status.kind === 'readable' && status.status.lockHold?.path === lockPath;
      }, 3_000);
      expect(held.exitCode).toBeNull();
      start(otherHome);
      const other = await waitForDiscoveryRecord(otherHome, 'prod', 15_000);
      children.push(other);
      await expect(
        requestIpcMethod(other.socketPath, 'transport.health', undefined, {
          auth: { kind: 'boot', token: other.bootToken },
          timeoutMs: 1_000,
        }),
      ).resolves.toMatchObject({ status: 'ok' });
      if (inode !== undefined) expect(statSync(lockPath).ino).toBe(inode);
      expect(held.exitCode).toBeNull();
      rmSync(marker);
      const recovered = await waitForDiscoveryRecord(home, 'prod', 15_000);
      children.push(recovered);
      expect(readLaunchStatus(runDir)).toMatchObject({ kind: 'readable' });
      const status = readLaunchStatus(runDir);
      expect(status.kind === 'readable' && status.status.lockHold).toBeUndefined();
      await expect(
        requestIpcMethod(recovered.socketPath, 'transport.health', undefined, {
          auth: { kind: 'boot', token: recovered.bootToken },
          timeoutMs: 1_000,
        }),
      ).resolves.toMatchObject({ status: 'ok' });
    } finally {
      const identities = new Map<number, string>();
      for (const child of children) {
        if (child.incarnation !== undefined) identities.set(child.pid, child.incarnation);
      }
      await stopFixtureProcesses(supervisors, identities);
      for (const root of roots.reverse()) rmSync(root, { recursive: true, force: true });
    }
  },
  40_000,
);

it.each([
  'admission',
  'lifetime missing',
  'lifetime damaged',
  'status',
  'owner markers',
  'claim markers',
  'credential',
] as const)(
  'confines corrupt %s evidence during supervisor recovery while an independent namespace boots',
  async (artifact) => {
    const roots: string[] = [];
    const home = mkdtempSync(join(tmpdir(), 'coral-artifact-recovery-'));
    const otherHome = mkdtempSync(join(tmpdir(), 'coral-artifact-independent-'));
    roots.push(home, otherHome);
    const fixture = createPluginFixture(roots, { flavor: 'prod', version: '0.10.14' });
    const runDir = coordinatorPaths('prod', { baseDir: join(home, '.coral') }).runDir;
    const harness = join(home, 'supervisor.mjs');
    await build({
      entryPoints: [fileURLToPath(new URL('./fixtures/namespace-supervisor-harness.ts', import.meta.url))],
      outfile: harness,
      bundle: true,
      platform: 'node',
      format: 'esm',
      external: ['node:*'],
    });
    const supervisors: ReturnType<typeof spawn>[] = [];
    const identities = new Map<number, string>();
    const evidence = new SupervisorEvidence(runDir);
    const remember = (): void => {
      const state = evidence.read();
      for (const identity of [state.owner?.process, state.launch?.child, state.attempt?.child])
        if (identity?.incarnation !== undefined && identity.incarnation !== null)
          identities.set(identity.pid, identity.incarnation);
      for (const entry of listLaunchAdmissions(runDir)) {
        if (entry.kind !== 'readable') continue;
        for (const identity of [entry.admission.parent, entry.admission.child]) {
          if (identity.incarnation !== null) identities.set(identity.pid, identity.incarnation);
        }
      }
    };
    const start = (root: string) => {
      const supervisor = spawn(process.execPath, [harness, join(fixture.root, 'bridge', 'coral-backend.cjs')], {
        env: {
          ...process.env,
          HOME: root,
          TMPDIR: root,
          CORAL_FIXTURE_REAL_BACKEND: '1',
          CORAL_SENTINEL_RUN_DIR: coordinatorPaths('prod', { baseDir: join(root, '.coral') }).runDir,
        },
        stdio: 'ignore',
      });
      supervisors.push(supervisor);
      return supervisor;
    };
    try {
      const original = start(home);
      const serving = await waitForDiscoveryRecord(home, 'prod', 15_000);
      if (serving.incarnation !== undefined) identities.set(serving.pid, serving.incarnation);
      await waitForCondition(() => {
        remember();
        return evidence.read().launch?.phase === 'serving';
      }, 5_000);
      const admission = evidence.read().launch!;
      const [subject] = listLaunchSubjects(runDir);
      if (artifact === 'admission') writeFileSync(launchAdmissionPath(runDir, admission.id), '{');
      else if (artifact.startsWith('lifetime')) {
        if (subject?.lifetimePath === undefined) throw new Error('Missing lifetime fixture');
        if (artifact === 'lifetime missing') rmSync(subject.lifetimePath);
        else writeFileSync(subject.lifetimePath, 'damaged independent lifetime bytes');
      } else if (artifact === 'status') writeFileSync(join(runDir, 'launch-status.v1.json'), '{');
      else if (artifact === 'credential') {
        const db = new DatabaseSync(storeDbPathForHome(home, 'prod'));
        try {
          db.exec('PRAGMA busy_timeout = 5000');
          db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('child_principal_credential.v1:damaged', '{');
        } finally {
          db.close();
        }
      } else {
        const lock = join(runDir, 'launch-status.v1.lock');
        mkdirSync(lock, { recursive: true });
        for (const id of ['one', 'two'])
          writeFileSync(join(lock, `${artifact.startsWith('owner') ? 'owner' : 'claim'}-${id}.lock`), '{}');
      }
      original.kill('SIGKILL');
      await waitForCondition(() => {
        remember();
        return evidence.lockHolder() !== null && evidence.lockHolder()?.pid !== original.pid;
      }, 10_000);
      start(otherHome);
      const independent = await waitForDiscoveryRecord(otherHome, 'prod', 15_000);
      if (independent.incarnation !== undefined) identities.set(independent.pid, independent.incarnation);
      await expect(
        requestIpcMethod(independent.socketPath, 'transport.health', undefined, {
          auth: { kind: 'boot', token: independent.bootToken },
          timeoutMs: 1_000,
        }),
      ).resolves.toMatchObject({ status: 'ok' });
      await vi.waitFor(
        async () => {
          const current = readDiscoveryRecordForHome(home, 'prod');
          if (current === null) throw new Error('Recovery has not published discovery.');
          if (current.incarnation !== undefined) identities.set(current.pid, current.incarnation);
          await expect(
            requestIpcMethod(current.socketPath, 'transport.health', undefined, {
              auth: { kind: 'boot', token: current.bootToken },
              timeoutMs: 1_000,
            }),
          ).resolves.toMatchObject({ status: 'ok', pid: current.pid });
        },
        { timeout: 15_000, interval: 50 },
      );
      if (artifact.startsWith('lifetime')) {
        expect(probeProcessIncarnation(serving.pid)).toBe(serving.incarnation);
        expect(evidence.read().launch?.child.pid).toBe(serving.pid);
      }
    } finally {
      remember();
      await stopFixtureProcesses(supervisors, identities);
      for (const root of roots.reverse()) rmSync(root, { recursive: true, force: true });
    }
  },
  45_000,
);

it.runIf(process.platform === 'darwin')(
  'keeps serving with a parent-silent status and a waiting upgrade under permanent macOS parent SIGSTOP',
  async () => {
    const roots: string[] = [];
    const home = mkdtempSync(join(tmpdir(), 'coral-macos-parent-silence-'));
    roots.push(home);
    const fixture = createPluginFixture(roots, { flavor: 'prod', version: '0.10.14', backend: 'supervisor-silence' });
    const target = createPluginFixture(roots, { flavor: 'prod', version: '0.10.15' });
    const runDir = coordinatorPaths('prod', { baseDir: join(home, '.coral') }).runDir;
    const harness = join(home, 'supervisor.mjs');
    await build({
      entryPoints: [fileURLToPath(new URL('./fixtures/namespace-supervisor-harness.ts', import.meta.url))],
      outfile: harness,
      bundle: true,
      platform: 'node',
      format: 'esm',
      external: ['node:*'],
    });
    const parent = spawn(process.execPath, [harness, join(fixture.root, 'bridge', 'coral-backend.cjs')], {
      env: {
        ...process.env,
        HOME: home,
        TMPDIR: home,
        CORAL_SENTINEL_RUN_DIR: runDir,
        CORAL_FIXTURE_REAL_BACKEND: '1',
      },
      stdio: 'ignore',
    });
    const evidence = new SupervisorEvidence(runDir);
    let serving: Awaited<ReturnType<typeof waitForDiscoveryRecord>> | undefined;
    try {
      serving = await waitForDiscoveryRecord(home, 'prod', 15_000);
      const inode = statSync(join(runDir, 'namespace-supervisor.v1.lock')).ino;
      parent.kill('SIGSTOP');
      await waitForCondition(() => {
        const status = readLaunchStatus(runDir);
        return (
          status.kind === 'readable' && status.status.signalHolds.some((hold) => hold.disposition === 'parent-silent')
        );
      }, 5_000);
      await evidence.request(join(target.root, 'bridge', 'coral-backend.cjs'), buildSetId(target.root));
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      vi.stubEnv('HOME', home);
      vi.stubEnv('TMPDIR', home);
      const status = await getBackendStatusFull(fixture.root);
      expect(status.status).toBe('ok');
      expect(formatBackendStatus(status, { kind: 'absent' }, null)).toContain('parent-silent');
      expect(status.launchSignalHolds).toContainEqual(
        expect.objectContaining({ pid: parent.pid, disposition: 'parent-silent' }),
      );
      expect(statSync(join(runDir, 'namespace-supervisor.v1.lock')).ino).toBe(inode);
      expect(attemptExclusiveFileLockSync(join(runDir, 'namespace-supervisor.v1.lock')).kind).toBe('contended');
      expect(parent.signalCode).toBeNull();
      expect(readUpgradeIntent(runDir)).toMatchObject({ kind: 'readable', intent: { disposition: 'pending' } });
      expect(evidence.read().launch?.child.pid).toBe(serving.pid);
    } finally {
      vi.unstubAllEnvs();
      const nominees =
        serving === undefined
          ? []
          : execFileSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' })
              .trim()
              .split('\n')
              .flatMap((row) => {
                const [pid, ppid] = row.trim().split(/\s+/u).map(Number);
                if (ppid !== serving!.pid) return [];
                const incarnation = probeProcessIncarnation(pid);
                return incarnation === null ? [] : [{ pid, incarnation }];
              });
      const identities = new Map(nominees.map(({ pid, incarnation }) => [pid, incarnation]));
      if (serving?.incarnation !== undefined) identities.set(serving.pid, serving.incarnation);
      await stopFixtureProcesses([parent], identities);
      for (const root of roots.reverse()) rmSync(root, { recursive: true, force: true });
    }
  },
  35_000,
);

it('repairs after an inherited child stops, holds with refused-only termination, then resumes (native macOS refusal on macOS)', async () => {
  const roots: string[] = [];
  const home = mkdtempSync(join(tmpdir(), 'coral-inherited-resume-'));
  roots.push(home);
  const fixture = createPluginFixture(roots, {
    flavor: 'prod',
    version: '0.10.14',
    backend: 'supervisor-silence',
    accepts: 'bundled',
  });
  const runDir = coordinatorPaths('prod', { baseDir: join(home, '.coral') }).runDir;
  const sentinel = join(fixture.root, 'bridge', 'coral-sentinel.cjs');
  const marker = join(home, 'stopped.json');
  const log = join(home, 'memory.jsonl');
  await build({
    entryPoints: [fileURLToPath(new URL('./fixtures/namespace-supervisor-harness.ts', import.meta.url))],
    outfile: sentinel,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['node:*'],
    banner: { js: 'var __importMetaUrl=require("url").pathToFileURL(__filename).href;' },
    define: { 'import.meta.url': '__importMetaUrl' },
    plugins: [
      {
        name: 'inherited-child-refusal-and-observation',
        setup(builder) {
          builder.onLoad({ filter: /\/coordinator-launch\/(ownership|child-process)\.ts$/ }, ({ path }) => {
            let contents = readFileSync(path, 'utf8');
            if (path.endsWith('/ownership.ts')) {
              contents = contents.replace(
                "if (replacement) process.send?.({ kind: 'coral-recovery-owned', challenge: recoveryChallenge });",
                `if (replacement) {
                const sourcePid = Number(process.env.CORAL_RECOVERY_SOURCE_PID);
                process.send?.({ kind: 'coral-recovery-owned', challenge: recoveryChallenge });
                process.kill(sourcePid, 'SIGSTOP');
                fixtureWrite(process.env.CORAL_FIXTURE_STOP_MARKER!, JSON.stringify({ pid: process.pid, child: sourcePid }));
              }`,
              );
              contents = contents.replace(
                'const record = new SupervisorLaunchMemory(runDir, { pid: process.pid, incarnation }, manifest.buildSetId);',
                `const record = new SupervisorLaunchMemory(runDir, { pid: process.pid, incarnation }, manifest.buildSetId);
              const fixtureObservation = setInterval(() => fixtureAppend(process.env.CORAL_FIXTURE_MEMORY_LOG!,
                JSON.stringify({ pid: process.pid, state: record.read() }) + '\\n'), 50);
              fixtureObservation.unref();`,
              );
            } else {
              const start = contents.indexOf('function signalInheritedChild(');
              const end = contents.indexOf('function spawnAdmittedChild(', start);
              const signalling = contents.slice(start, end);
              const refused =
                process.platform === 'darwin'
                  ? signalling
                  : signalling.replace(
                      '!incarnationMayAuthorizeSignal(process.platform)',
                      'true || !incarnationMayAuthorizeSignal(process.platform)',
                    );
              if (start < 0 || end < 0 || (process.platform !== 'darwin' && refused === signalling))
                throw new Error('Missing inherited signal fixture target');
              contents = contents.slice(0, start) + refused + contents.slice(end);
            }
            return {
              contents: `import { writeFileSync as fixtureWrite, appendFileSync as fixtureAppend } from 'node:fs';\n${contents}`,
              loader: 'ts',
            };
          });
        },
      },
    ],
  });
  const parent = spawn(process.execPath, [sentinel, join(fixture.root, 'bridge', 'coral-backend.cjs')], {
    env: {
      ...process.env,
      HOME: home,
      TMPDIR: home,
      CORAL_SENTINEL_RUN_DIR: runDir,
      CORAL_FIXTURE_REAL_BACKEND: '1',
      CORAL_FIXTURE_STOP_MARKER: marker,
      CORAL_FIXTURE_MEMORY_LOG: log,
    },
    stdio: 'ignore',
  });
  const evidence = new SupervisorEvidence(runDir);
  const identities = new Map<number, string>();
  const observations = () => {
    try {
      return readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .map(
          (line) =>
            JSON.parse(line) as {
              pid: number;
              state: {
                owner: { mode: string };
                launch: {
                  id: string;
                  phase: string;
                  terminationAt?: number;
                  killAt?: number;
                  termDelivered?: boolean;
                  killDelivered?: boolean;
                } | null;
              };
            },
        );
    } catch {
      return [];
    }
  };
  try {
    const first = await waitForDiscoveryRecord(home, 'prod', 15_000);
    if (first.incarnation !== undefined) identities.set(first.pid, first.incarnation);
    const launchId = first.supervision!.launchId;
    await waitForCondition(() => evidence.read().launch?.phase === 'serving', 5_000);
    parent.kill('SIGKILL');
    await waitForCondition(() => {
      try {
        return JSON.parse(readFileSync(marker, 'utf8')).child === first.pid;
      } catch {
        return false;
      }
    }, 5_000);
    const replacement = JSON.parse(readFileSync(marker, 'utf8')) as { pid: number };
    const replacementIncarnation = probeProcessIncarnation(replacement.pid);
    if (replacementIncarnation !== null) identities.set(replacement.pid, replacementIncarnation);
    await waitForCondition(() => {
      const status = readLaunchStatus(runDir);
      return status.kind === 'readable' && status.status.inheritedHolds.some((hold) => hold.launchId === launchId);
    }, 12_000);
    await new Promise((resolve) => setTimeout(resolve, 400));
    const committed = observations().filter(
      (event) =>
        event.pid === replacement.pid &&
        event.state.launch?.id === launchId &&
        event.state.launch.terminationAt !== undefined,
    );
    expect(committed.length).toBeGreaterThan(0);
    expect(
      committed.every(
        (event) => event.state.launch?.termDelivered !== true && event.state.launch?.killDelivered !== true,
      ),
    ).toBe(true);
    const resumedAt = Date.now();
    process.kill(first.pid, 'SIGCONT');
    await waitForCondition(
      () =>
        observations().some(
          (event) =>
            event.pid === replacement.pid &&
            event.state.launch?.id === launchId &&
            event.state.launch.phase === 'serving' &&
            event.state.launch.terminationAt === undefined &&
            event.state.launch.killAt === undefined,
        ),
      5_000,
    );
    await waitForCondition(() => {
      const state = evidence.read();
      for (const identity of [state.launch?.child, state.attempt?.child])
        if (identity?.incarnation !== undefined && identity.incarnation !== null)
          identities.set(identity.pid, identity.incarnation);
      return (
        state.launch?.phase === 'serving' &&
        state.launch.child.pid !== first.pid &&
        state.launch.parent.pid === replacement.pid
      );
    }, 25_000);
    await waitForCondition(
      () => observations().some((event) => event.pid === replacement.pid && event.state.owner.mode === 'supervised'),
      5_000,
    );
    expect(Date.now() - resumedAt).toBeLessThan(30_000);
    const status = readLaunchStatus(runDir);
    expect(status.kind === 'readable' && status.status.inheritedHolds.some((hold) => hold.launchId === launchId)).toBe(
      false,
    );
  } finally {
    const state = evidence.read();
    for (const identity of [state.launch?.child, state.attempt?.child])
      if (identity?.incarnation !== undefined && identity.incarnation !== null)
        identities.set(identity.pid, identity.incarnation);
    await stopFixtureProcesses([parent], identities);
    for (const root of roots.reverse()) rmSync(root, { recursive: true, force: true });
  }
}, 50_000);
