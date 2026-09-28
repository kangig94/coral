import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { build, type PluginBuild } from 'esbuild';
import { describe, expect, it } from 'vitest';

import { CoordinatorLaunchRecord } from '#src/infra/coordinator-launch.js';
import { probeProcessIncarnation, type ProcessIncarnation } from '#src/infra/node-process.js';
import {
  CURRENT_STRICT_BUNDLE_MANIFEST_FILE,
  SUCCESSION_CAPABILITIES_FILE,
} from '#src/infra/bundle-manifest-address.js';
import { coordinatorPaths, socketPathForRunDir } from '#src/infra/path/coordinator.js';
import { coordinatorLaunchPath } from '#src/infra/path/index.js';
import { readUpgradeIntent } from '#src/infra/upgrade-intent.js';
import { readHandoffCapsuleFile } from '#src/provider-proxy/handoff-capsule.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { createPluginFixture } from '#tests/integration/coordinator/helpers.js';
import { waitForCondition } from '#tests/support/wait-for-condition.js';
import { topLevelCliEnvironment } from '#tests/support/top-level-cli-environment.js';

function buildSetId(root: string): string {
  return (
    JSON.parse(readFileSync(join(root, 'bridge', CURRENT_STRICT_BUNDLE_MANIFEST_FILE), 'utf8')) as {
      buildSetId: string;
    }
  ).buildSetId;
}

describe('namespace supervisor recovery', () => {
  it('keeps a live coordinator recorded after a child IPC error', async () => {
    const roots: string[] = [];
    const home = mkdtempSync(join(tmpdir(), 'coral-child-ipc-error-'));
    roots.push(home);
    const plugin = createPluginFixture(roots, { flavor: 'prod', version: '0.10.14' });
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
    const supervisor = spawn(process.execPath, [harness, join(plugin.root, 'bridge', 'coral-backend.cjs')], {
      env: { ...process.env, HOME: home, TMPDIR: home, CORAL_SENTINEL_RUN_DIR: runDir },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    const record = new CoordinatorLaunchRecord(runDir);
    const pids = new Set<number>();
    try {
      await waitForCondition(() => record.read().launch?.phase === 'serving', 20_000);
      const servingPid = record.read().launch?.child?.pid;
      if (servingPid === undefined) throw new Error('Serving child has no PID');
      pids.add(servingPid);
      supervisor.send('error-coordinator-channel');
      await new Promise((resolve) => setTimeout(resolve, 700));
      expect(record.read().launch).toMatchObject({ phase: 'serving', child: { pid: servingPid } });
      expect(record.read().owner?.process.pid).toBe(supervisor.pid);
    } finally {
      const state = record.read();
      for (const pid of [state.owner?.process.pid, state.launch?.child?.pid]) {
        if (pid !== undefined) pids.add(pid);
      }
      record.close();
      supervisor.kill('SIGKILL');
      for (const pid of pids) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // The fixture may already have exited.
        }
      }
      for (const root of roots.reverse()) rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
  it.runIf(process.platform === 'linux')(
    'retires a disconnected coordinator that wedges before repair',
    async () => {
      const roots: string[] = [];
      const home = mkdtempSync(join(tmpdir(), 'coral-disconnected-wedge-'));
      roots.push(home);
      const plugin = createPluginFixture(roots, { flavor: 'prod', version: '0.10.14' });
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
      const supervisor = spawn(process.execPath, [harness, join(plugin.root, 'bridge', 'coral-backend.cjs')], {
        env: { ...process.env, HOME: home, TMPDIR: home, CORAL_SENTINEL_RUN_DIR: runDir },
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      });
      const record = new CoordinatorLaunchRecord(runDir);
      const pids = new Set<number>();
      let stoppedPid: number | undefined;
      try {
        await waitForCondition(() => record.read().launch?.phase === 'serving', 20_000);
        stoppedPid = record.read().launch?.child?.pid;
        if (stoppedPid === undefined) throw new Error('Serving child has no PID');
        pids.add(stoppedPid);
        await new Promise<void>((resolve, reject) =>
          supervisor.send('disconnect-coordinator', (error) => (error ? reject(error) : resolve())),
        );
        process.kill(stoppedPid, 'SIGSTOP');
        await waitForCondition(
          () => record.read().launch?.phase === 'serving' && record.read().launch?.child?.pid !== stoppedPid,
          20_000,
        );
        expect(record.read().owner?.process.pid).toBe(supervisor.pid);
        expect(probeProcessIncarnation(stoppedPid)).toBeNull();
        expect(supervisor.exitCode).toBeNull();
      } finally {
        const state = record.read();
        for (const pid of [state.owner?.process.pid, state.launch?.child?.pid]) if (pid !== undefined) pids.add(pid);
        record.close();
        supervisor.kill('SIGKILL');
        for (const pid of pids) {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            // The fixture may already have exited.
          }
        }
        for (const root of roots.reverse()) rmSync(root, { recursive: true, force: true });
      }
    },
    40_000,
  );
  it.each(['launch', 'serving attempt'] as const)(
    'repairs a disconnected %s coordinator while its original supervisor stays alive and its job survives',
    async (source) => {
      const roots: string[] = [];
      const home = mkdtempSync(join(tmpdir(), 'coral-disconnected-supervisor-'));
      roots.push(home);
      const plugin = createPluginFixture(roots, {
        flavor: 'prod',
        version: '0.10.14',
        backend: 'succession-interposition',
        accepts: 'bundled',
      });
      const successor =
        source === 'serving attempt'
          ? createPluginFixture(roots, {
              flavor: 'prod',
              version: '0.10.15',
              backend: 'succession-interposition',
              accepts: 'bundled',
            })
          : null;
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
      const supervisor = spawn(process.execPath, [harness, join(plugin.root, 'bridge', 'coral-backend.cjs')], {
        env: {
          ...process.env,
          HOME: home,
          TMPDIR: home,
          PATH: `${join(home, 'bin')}:${process.env.PATH ?? ''}`,
          CORAL_SENTINEL_RUN_DIR: runDir,
          ...(successor === null ? {} : { CORAL_TEST_SUCCESSION_RELEASE_DELAY_MS: '10000' }),
        },
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      });
      const record = new CoordinatorLaunchRecord(runDir);
      const pids = new Set<number>();
      const hosts: { pid: number; incarnation: ProcessIncarnation }[] = [];
      let cli: ReturnType<typeof spawn> | null = null;
      try {
        await waitForCondition(() => record.read().launch?.phase === 'serving', 20_000);
        const originalPid = record.read().launch?.child?.pid;
        if (originalPid === undefined) throw new Error('Serving child has no PID');
        pids.add(originalPid);
        const binDir = join(home, 'bin');
        const stateDir = join(home, '.fake-codex-state');
        const projectRoot = join(home, 'project');
        mkdirSync(binDir);
        mkdirSync(stateDir);
        mkdirSync(projectRoot);
        mkdirSync(join(home, '.codex'));
        mkdirSync(join(home, '.claude'));
        writeFileSync(
          join(home, '.codex', 'auth.json'),
          JSON.stringify({ tokens: { access_token: 'fake-access-token', account_id: 'fake-account-id' } }),
        );
        const fakeCodex = join(binDir, 'codex');
        copyFileSync(join(process.cwd(), 'tests', 'fixtures', 'transfer-codex-appserver.cjs'), fakeCodex);
        chmodSync(fakeCodex, 0o755);
        const prompt = join(projectRoot, 'prompt.txt');
        writeFileSync(prompt, 'Keep this provider job running during supervisor repair.');
        const launchedCli = spawn(
          'node',
          [join(plugin.root, 'bridge', 'coral-cli'), 'codex', '-i', prompt, '--detach'],
          {
            cwd: projectRoot,
            env: topLevelCliEnvironment(home, { PATH: `${binDir}:${process.env.PATH ?? ''}` }),
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
        cli = launchedCli;
        let cliOutput = '';
        launchedCli.stdout?.on('data', (chunk: Buffer) => (cliOutput += chunk.toString()));
        launchedCli.stderr?.on('data', (chunk: Buffer) => (cliOutput += chunk.toString()));
        await waitForCondition(() => launchedCli.exitCode !== null, 30_000);
        expect(launchedCli.exitCode, cliOutput).toBe(0);
        try {
          await waitForCondition(() => existsSync(join(stateDir, 'job-running')), 30_000);
        } catch (error: unknown) {
          throw new Error(`Provider job did not start: ${cliOutput}`, { cause: error });
        }
        let capsulePath: string | undefined;
        await waitForCondition(() => {
          capsulePath = readdirSync(runDir).find((name) =>
            /^provider-1[0-9a-f]{23}\.handoff\.v[34]\.json$/u.test(name),
          );
          return capsulePath !== undefined;
        }, 20_000);
        if (capsulePath === undefined) throw new Error('Provider host capsule is unavailable');
        const capsule = readHandoffCapsuleFile(join(runDir, capsulePath), {
          storage: createRealRuntime('prod', { baseDir: join(home, '.coral') }).storage,
          uid: process.getuid?.() ?? 0,
        });
        if (capsule === null || (capsule.version !== 3 && capsule.version !== 4))
          throw new Error('Provider host capsule is unreadable');
        hosts.push(
          { pid: capsule.guardianPid, incarnation: capsule.guardianIncarnation },
          { pid: capsule.reaperPid, incarnation: capsule.reaperIncarnation },
          { pid: capsule.proxyPid, incarnation: capsule.proxyIncarnation },
        );
        const jobPid = Number(readFileSync(join(stateDir, 'job-running'), 'utf8'));
        const jobIncarnation = probeProcessIncarnation(jobPid);
        if (jobIncarnation === null) throw new Error('Provider job process has no incarnation');
        hosts.push({ pid: jobPid, incarnation: jobIncarnation });
        const healthBeforeDisconnect = record.read().attempt?.observedHealthyAt ?? 0;
        let disconnectedPid = originalPid;
        if (successor === null) supervisor.send('disconnect-coordinator');
        else {
          record.request(join(successor.root, 'bridge', 'coral-backend.cjs'), buildSetId(successor.root));
          await waitForCondition(() => record.read().attempt?.phase === 'serving', 30_000);
          const attemptPid = record.read().attempt?.child?.pid;
          if (attemptPid === undefined) throw new Error('Serving attempt has no PID');
          disconnectedPid = attemptPid;
          pids.add(attemptPid);
          process.kill(attemptPid, 'SIGUSR2');
        }
        await waitForCondition(() => record.read().owner?.process.pid !== supervisor.pid, 10_000);
        const replacementPid = record.read().owner?.process.pid;
        if (replacementPid !== undefined) pids.add(replacementPid);
        expect(supervisor.exitCode).toBeNull();
        await waitForCondition(() => {
          const state = record.read();
          const repaired = [state.launch, state.attempt].find((slot) => slot?.child?.pid === disconnectedPid);
          return source === 'launch'
            ? state.launch?.phase === 'serving' &&
                state.launch.child?.pid !== originalPid &&
                state.launch.parent?.pid === replacementPid
            : repaired?.phase === 'serving' && state.owner?.process.pid === replacementPid;
        }, 20_000);
        if (source === 'launch') expect(record.read().owner?.mode).toBe('supervised');
        else {
          await waitForCondition(
            () => (record.read().attempt?.observedHealthyAt ?? 0) > healthBeforeDisconnect,
            10_000,
          );
          expect(record.read().owner?.mode).toBe('recovering');
          expect(record.read().launch?.child?.pid).toBe(originalPid);
        }
        expect(hosts.every(({ pid, incarnation }) => probeProcessIncarnation(pid) === incarnation)).toBe(true);
        writeFileSync(join(stateDir, 'release-job'), '');
        await waitForCondition(() => existsSync(join(stateDir, 'terminal-completed')), 20_000);
        if (source === 'serving attempt') {
          try {
            await waitForCondition(() => {
              const state = record.read();
              return (
                state.launch?.phase === 'serving' &&
                state.launch.child?.pid !== disconnectedPid &&
                state.launch.parent?.pid === state.owner?.process.pid &&
                state.owner?.mode === 'supervised'
              );
            }, 30_000);
          } catch (error: unknown) {
            throw new Error(
              `Serving attempt did not complete supervision repair: state=${JSON.stringify(record.read())}; intent=${JSON.stringify(readUpgradeIntent(runDir))}`,
              { cause: error },
            );
          }
        }
      } finally {
        const state = record.read();
        for (const pid of [state.owner?.process.pid, state.launch?.child?.pid, state.attempt?.child?.pid]) {
          if (pid !== undefined) pids.add(pid);
        }
        record.close();
        cli?.kill('SIGKILL');
        supervisor.kill('SIGKILL');
        for (const pid of pids) {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            // The fixture may already have exited.
          }
        }
        for (const { pid, incarnation } of hosts) {
          if (probeProcessIncarnation(pid) !== incarnation) continue;
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            // The provider host may already have exited.
          }
        }
        for (const root of roots.reverse()) rmSync(root, { recursive: true, force: true });
      }
    },
    65_000,
  );
  it('repairs the serving coordinator after an inherited admitted attempt exits', async () => {
    const roots: string[] = [];
    const home = mkdtempSync(join(tmpdir(), 'coral-pending-attempt-repair-'));
    roots.push(home);
    const plugin = createPluginFixture(roots, { flavor: 'prod', version: '0.10.14' });
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
    const supervisor = spawn(process.execPath, [harness, join(plugin.root, 'bridge', 'coral-backend.cjs')], {
      env: { ...process.env, HOME: home, TMPDIR: home, CORAL_SENTINEL_RUN_DIR: runDir },
      stdio: 'ignore',
    });
    const attempt = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    const record = new CoordinatorLaunchRecord(runDir);
    const pids = new Set<number>();
    try {
      await waitForCondition(() => record.read().launch?.phase === 'serving', 20_000);
      const original = record.read();
      const owner = original.owner;
      const servingPid = original.launch?.child?.pid;
      const attemptIncarnation = attempt.pid === undefined ? null : probeProcessIncarnation(attempt.pid);
      if (owner === null || servingPid === undefined || attempt.pid === undefined || attemptIncarnation === null)
        throw new Error('Fixture processes are unavailable');
      pids.add(servingPid);
      const reserved = record.reserve(owner, 'unused-build', 'succession', Date.now());
      if (reserved === null) throw new Error('Attempt was not reserved');
      expect(
        record.admit(reserved, owner.process, { pid: attempt.pid, incarnation: attemptIncarnation }, Date.now()),
      ).toBe(true);
      supervisor.kill('SIGKILL');
      await waitForCondition(() => record.read().owner?.process.pid !== supervisor.pid, 10_000);
      const replacementPid = record.read().owner?.process.pid;
      if (replacementPid !== undefined) pids.add(replacementPid);
      attempt.kill('SIGKILL');
      await waitForCondition(() => record.read().attempt?.phase === 'exited', 10_000);
      await waitForCondition(
        () =>
          record.read().launch?.phase === 'serving' &&
          record.read().launch?.child?.pid !== servingPid &&
          record.read().launch?.parent?.pid === replacementPid,
        15_000,
      );
    } finally {
      const state = record.read();
      for (const pid of [state.owner?.process.pid, state.launch?.child?.pid, state.attempt?.child?.pid]) {
        if (pid !== undefined) pids.add(pid);
      }
      record.close();
      supervisor.kill('SIGKILL');
      attempt.kill('SIGKILL');
      for (const pid of pids) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // The fixture may already have exited.
        }
      }
      for (const root of roots.reverse()) rmSync(root, { recursive: true, force: true });
    }
  }, 45_000);
  it.each(['predecessor', 'successor'] as const)(
    'repairs a serving succession when the %s replacement wins, then serves two upgrades',
    async (winner) => {
      const roots: string[] = [];
      const pids = new Set<number>();
      const home = mkdtempSync(join(tmpdir(), 'coral-red-inherited-attempt-'));
      roots.push(home);
      const incumbent = createPluginFixture(roots, {
        flavor: 'prod',
        version: '0.10.14',
        backend: 'succession-interposition',
        accepts: 'bundled',
      });
      const successor = createPluginFixture(roots, {
        flavor: 'prod',
        version: '0.10.15',
        backend: 'succession-interposition',
        accepts: 'bundled',
      });
      const later = createPluginFixture(roots, {
        flavor: 'prod',
        version: '0.10.16',
        backend: 'succession-interposition',
        accepts: 'bundled',
      });
      const last = createPluginFixture(roots, {
        flavor: 'prod',
        version: '0.10.17',
        backend: 'succession-interposition',
        accepts: 'bundled',
      });
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
      const supervisor = spawn(process.execPath, [harness, join(incumbent.root, 'bridge', 'coral-backend.cjs')], {
        env: {
          ...process.env,
          HOME: home,
          TMPDIR: home,
          CORAL_SENTINEL_RUN_DIR: runDir,
          CORAL_TEST_SUCCESSION_RELEASE_DELAY_MS: '5000',
        },
        stdio: 'ignore',
      });
      const record = new CoordinatorLaunchRecord(runDir);
      const incumbentBuildSetId = buildSetId(incumbent.root);
      const successorBuildSetId = buildSetId(successor.root);
      const retainedIncumbent = join(home, '.coral', 'gen2', 'builds', incumbentBuildSetId);
      const retainedSuccessor = join(home, '.coral', 'gen2', 'builds', successorBuildSetId);
      const blockedRoot = winner === 'predecessor' ? successor.root : incumbent.root;
      const blockedRetained = winner === 'predecessor' ? retainedSuccessor : retainedIncumbent;
      const heldRoot = join(home, 'held-root');
      const heldRetained = join(home, 'held-retained');
      const rememberProcesses = (): void => {
        const state = record.read();
        for (const process of [
          state.owner?.process,
          state.launch?.parent,
          state.launch?.child,
          state.attempt?.parent,
          state.attempt?.child,
        ]) {
          if (process !== undefined) pids.add(process.pid);
        }
      };

      try {
        await waitForCondition(() => record.read().launch?.phase === 'serving', 20_000);
        record.request(join(successor.root, 'bridge', 'coral-backend.cjs'), buildSetId(successor.root));
        await waitForCondition(() => record.read().attempt?.phase === 'serving', 30_000);
        rememberProcesses();

        await waitForCondition(() => existsSync(retainedSuccessor) && existsSync(retainedIncumbent), 10_000);
        renameSync(blockedRoot, heldRoot);
        renameSync(blockedRetained, heldRetained);
        supervisor.kill('SIGKILL');
        expect(record.read().attempt).toMatchObject({ phase: 'serving', buildSetId: successorBuildSetId });
        await waitForCondition(
          () =>
            record.read().owner?.process.pid !== supervisor.pid &&
            record.read().owner?.buildSetId === (winner === 'predecessor' ? incumbentBuildSetId : successorBuildSetId),
          20_000,
        );
        rememberProcesses();
        renameSync(heldRoot, blockedRoot);
        renameSync(heldRetained, blockedRetained);
        try {
          await waitForCondition(
            () => record.read().launch?.phase === 'serving' && record.read().launch?.buildSetId === successorBuildSetId,
            20_000,
          );
        } catch (error: unknown) {
          throw new Error(`Serving successor was not normalized: ${JSON.stringify(record.read())}`, { cause: error });
        }
        await waitForCondition(() => record.read().owner?.buildSetId === successorBuildSetId, 20_000);
        const requested = record.request(join(later.root, 'bridge', 'coral-backend.cjs'), buildSetId(later.root));
        try {
          await waitForCondition(
            () =>
              record.read().launch?.phase === 'serving' &&
              record.read().launch?.buildSetId === buildSetId(later.root) &&
              record.read().requests.find((request) => request.id === requested.id)?.status === 'completed',
            15_000,
          );
        } catch (error: unknown) {
          throw new Error(`Later upgrade remained unserved: ${JSON.stringify(record.read())}`, { cause: error });
        }
        const finalRequest = record.request(join(last.root, 'bridge', 'coral-backend.cjs'), buildSetId(last.root));
        await waitForCondition(
          () =>
            record.read().launch?.phase === 'serving' &&
            record.read().launch?.buildSetId === buildSetId(last.root) &&
            record.read().requests.find((request) => request.id === finalRequest.id)?.status === 'completed',
          20_000,
        );
        expect(record.read().owner?.mode).toBe('supervised');
        expect(record.read().launch?.parent).toEqual(record.read().owner?.process);
      } finally {
        if (existsSync(heldRoot)) renameSync(heldRoot, blockedRoot);
        if (existsSync(heldRetained)) renameSync(heldRetained, blockedRetained);
        rememberProcesses();
        record.close();
        if (supervisor.exitCode === null) supervisor.kill('SIGKILL');
        for (const pid of pids) {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            // The test process may already have exited.
          }
        }
        for (const root of roots.reverse()) rmSync(root, { recursive: true, force: true });
      }
    },
    90_000,
  );
  it('accepts a later upgrade after promoting an inherited coordinator successor', async () => {
    const roots: string[] = [];
    const home = mkdtempSync(join(tmpdir(), 'coral-inherited-upgrade-chain-'));
    roots.push(home);
    const first = createPluginFixture(roots, { flavor: 'prod', version: '0.10.14' });
    const second = createPluginFixture(roots, { flavor: 'prod', version: '0.10.15' });
    const third = createPluginFixture(roots, { flavor: 'prod', version: '0.10.16' });
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
    const supervisor = spawn(process.execPath, [harness, join(first.root, 'bridge', 'coral-backend.cjs')], {
      env: { ...process.env, HOME: home, TMPDIR: home, CORAL_SENTINEL_RUN_DIR: runDir },
      stdio: 'ignore',
    });
    const record = new CoordinatorLaunchRecord(runDir);
    const pids: number[] = [];
    try {
      await waitForCondition(() => record.read().launch?.phase === 'serving', 20_000);
      const firstPid = record.read().launch?.child?.pid;
      if (firstPid === undefined) throw new Error('First coordinator has no PID');
      pids.push(firstPid);
      supervisor.kill('SIGKILL');
      await waitForCondition(() => record.read().owner?.process.pid !== supervisor.pid, 10_000);
      const replacementPid = record.read().owner?.process.pid;
      if (replacementPid !== undefined) pids.push(replacementPid);
      const next = record.request(join(second.root, 'bridge', 'coral-backend.cjs'), buildSetId(second.root));
      await waitForCondition(
        () => record.read().launch?.phase === 'serving' && record.read().launch?.buildSetId === buildSetId(second.root),
        25_000,
      );
      const secondPid = record.read().launch?.child?.pid;
      if (secondPid !== undefined) pids.push(secondPid);
      await waitForCondition(
        () => record.read().requests.find((entry) => entry.id === next.id)?.status === 'completed',
        5_000,
      );
      const last = record.request(join(third.root, 'bridge', 'coral-backend.cjs'), buildSetId(third.root));
      await waitForCondition(
        () => record.read().launch?.phase === 'serving' && record.read().launch?.buildSetId === buildSetId(third.root),
        25_000,
      );
      const thirdPid = record.read().launch?.child?.pid;
      if (thirdPid !== undefined) pids.push(thirdPid);
      await waitForCondition(
        () => record.read().requests.find((entry) => entry.id === last.id)?.status === 'completed',
        5_000,
      );
    } finally {
      record.close();
      if (supervisor.exitCode === null) supervisor.kill('SIGKILL');
      for (const pid of pids) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // The coordinator may have exited.
        }
      }
      for (const root of roots.reverse()) rmSync(root, { recursive: true, force: true });
    }
  }, 65_000);
  it.runIf(process.platform === 'linux')(
    'survives an inherited child exiting during its readiness probe',
    async () => {
      const roots: string[] = [];
      const home = mkdtempSync(join(tmpdir(), 'coral-inherited-probe-exit-'));
      roots.push(home);
      const original = createPluginFixture(roots, { flavor: 'prod', version: '0.10.14' });
      const recovery = createPluginFixture(roots, { flavor: 'prod', version: '0.10.16' });
      const runDir = coordinatorPaths('prod', { baseDir: join(home, '.coral') }).runDir;
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      const otherChild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      const record = new CoordinatorLaunchRecord(runDir);
      let supervisor: ReturnType<typeof spawn> | null = null;
      let recoveredPid: number | undefined;
      if (child.pid === undefined) throw new Error('Fixture child has no PID');
      const incarnation = probeProcessIncarnation(child.pid);
      if (incarnation === null) throw new Error('Fixture child has no incarnation');
      const identity = { pid: child.pid, incarnation };
      if (otherChild.pid === undefined) throw new Error('Other fixture child has no PID');
      const otherIncarnation = probeProcessIncarnation(otherChild.pid);
      if (otherIncarnation === null) throw new Error('Other fixture child has no incarnation');
      const otherIdentity = { pid: otherChild.pid, incarnation: otherIncarnation };
      const old = record.acquire(
        {
          id: 'dead-parent',
          process: { pid: process.pid, incarnation: 'dead-parent' as ProcessIncarnation },
          buildSetId: buildSetId(original.root),
        },
        Date.now(),
      );
      if (old === null) throw new Error('Fixture owner did not acquire');
      const slot = record.reserve(old, buildSetId(original.root), 'startup', Date.now());
      if (slot === null) throw new Error('Fixture reservation failed');
      expect(record.admit(slot, old.process, identity, Date.now() - 30_000)).toBe(true);
      expect(record.serving(slot, identity)).toBe(true);
      const attempt = record.reserve(old, buildSetId(recovery.root), 'succession', Date.now());
      if (attempt === null) throw new Error('Other fixture reservation failed');
      expect(record.admit(attempt, old.process, otherIdentity, Date.now() - 30_000)).toBe(true);
      expect(record.commitTermination(old, slot, identity, Date.now(), 80)).toBe(true);
      const server = createServer((socket) => {
        expect(record.exited(slot, identity)).toBe(true);
        child.kill('SIGKILL');
        rmSync(join(runDir, 'coordinator.json'), { force: true });
        socket.destroy();
        server.close();
      });
      const request = record.request(join(recovery.root, 'bridge', 'coral-backend.cjs'), buildSetId(recovery.root));
      writeFileSync(join(runDir, 'coordinator.json'), JSON.stringify({ pid: child.pid, bootToken: 'probe' }));
      await new Promise<void>((resolve) =>
        server.listen(socketPathForRunDir(runDir, 'prod', { platform: process.platform }), resolve),
      );
      try {
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
        supervisor = spawn(process.execPath, [harness, join(recovery.root, 'bridge', 'coral-backend.cjs')], {
          env: {
            ...process.env,
            HOME: home,
            TMPDIR: home,
            CORAL_SENTINEL_RUN_DIR: runDir,
          },
          stdio: 'ignore',
        });
        await waitForCondition(() => record.read().launch?.phase === 'exited', 5_000);
        try {
          await waitForCondition(
            () =>
              record.read().launch?.phase === 'serving' &&
              record.read().launch?.buildSetId === buildSetId(recovery.root),
            20_000,
          );
        } catch (error: unknown) {
          throw new Error(
            `Recovery stalled: ${JSON.stringify(record.read())}; supervisor exit ${supervisor.exitCode}`,
            {
              cause: error,
            },
          );
        }
        recoveredPid = record.read().launch?.child?.pid;
        expect(supervisor.exitCode).toBeNull();
        expect(probeProcessIncarnation(otherChild.pid)).toBeNull();
        await waitForCondition(
          () => record.read().requests.find((entry) => entry.id === request.id)?.status === 'completed',
          5_000,
        );
      } finally {
        if (server.listening) server.close();
        if (supervisor !== null && supervisor.exitCode === null) supervisor.kill('SIGKILL');
        child.kill('SIGKILL');
        otherChild.kill('SIGKILL');
        if (recoveredPid !== undefined) {
          try {
            process.kill(recoveredPid, 'SIGKILL');
          } catch {
            // Recovery may already have exited.
          }
        }
        record.close();
        for (const root of roots.reverse()) rmSync(root, { recursive: true, force: true });
      }
    },
    35_000,
  );
  it.runIf(process.platform === 'linux')(
    'escalates a wedged inherited child to KILL before recovery',
    async () => {
      const roots: string[] = [];
      const home = mkdtempSync(join(tmpdir(), 'coral-inherited-wedged-serving-'));
      roots.push(home);
      const original = createPluginFixture(roots, { flavor: 'prod', version: '0.10.14' });
      const recovery = createPluginFixture(roots, { flavor: 'prod', version: '0.10.16' });
      const runDir = coordinatorPaths('prod', { baseDir: join(home, '.coral') }).runDir;
      const stalled = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], {
        stdio: 'ignore',
      });
      const record = new CoordinatorLaunchRecord(runDir);
      let supervisor: ReturnType<typeof spawn> | null = null;
      try {
        if (stalled.pid === undefined) throw new Error('Fixture child has no PID');
        let incarnation = probeProcessIncarnation(stalled.pid);
        await waitForCondition(() => (incarnation = probeProcessIncarnation(stalled.pid!)) !== null, 5_000);
        if (incarnation === null) throw new Error('Fixture child has no incarnation');
        const old = record.acquire(
          {
            id: 'dead-parent',
            process: { pid: process.pid, incarnation: 'dead-parent' as typeof incarnation },
            buildSetId: buildSetId(original.root),
          },
          Date.now(),
        );
        if (old === null) throw new Error('Fixture owner did not acquire');
        const slot = record.reserve(old, buildSetId(original.root), 'startup', Date.now());
        if (slot === null) throw new Error('Fixture reservation failed');
        expect(record.admit(slot, old.process, { pid: stalled.pid, incarnation }, Date.now())).toBe(true);
        expect(record.serving(slot, { pid: stalled.pid, incarnation })).toBe(true);
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
        supervisor = spawn(process.execPath, [harness, join(recovery.root, 'bridge', 'coral-backend.cjs')], {
          env: { ...process.env, HOME: home, TMPDIR: home, CORAL_SENTINEL_RUN_DIR: runDir },
          stdio: 'ignore',
        });
        await waitForCondition(() => record.read().launch?.terminationAt !== undefined, 5_000);
        expect(record.read().launch?.killAt).toBeGreaterThan(record.read().launch?.terminationAt ?? Infinity);
        try {
          await waitForCondition(
            () =>
              record.read().launch?.phase === 'serving' &&
              record.read().launch?.buildSetId === buildSetId(recovery.root),
            10_000,
          );
        } catch (error: unknown) {
          throw new Error(`Inherited child recovery did not serve: ${JSON.stringify(record.read())}`, { cause: error });
        }
        await waitForCondition(() => stalled.exitCode !== null || stalled.signalCode !== null, 5_000);
        expect(stalled.signalCode).toBe('SIGKILL');
        expect(probeProcessIncarnation(stalled.pid)).not.toBe(incarnation);
      } finally {
        const currentPid = record.read().launch?.child?.pid;
        record.close();
        if (supervisor !== null && supervisor.exitCode === null) supervisor.kill('SIGKILL');
        if (stalled.exitCode === null) stalled.kill('SIGKILL');
        if (currentPid !== undefined && currentPid !== stalled.pid) {
          try {
            process.kill(currentPid, 'SIGKILL');
          } catch {
            // The recovery child may have exited.
          }
        }
        const stoppedSupervisor = supervisor;
        if (stoppedSupervisor !== null)
          await waitForCondition(
            () => stoppedSupervisor.exitCode !== null || stoppedSupervisor.signalCode !== null,
            5_000,
          );
        await waitForCondition(() => stalled.exitCode !== null || stalled.signalCode !== null, 5_000);
        await waitForCondition(() => {
          try {
            for (const root of roots.reverse()) rmSync(root, { recursive: true, force: true });
            return true;
          } catch (error: unknown) {
            if (error instanceof Error && 'code' in error && error.code === 'ENOTEMPTY') return false;
            throw error;
          }
        }, 5_000);
      }
    },
    20_000,
  );
  it('starts the newest installed eligible build ahead of an older bootstrap request', async () => {
    const roots: string[] = [];
    const home = mkdtempSync(join(tmpdir(), 'coral-installed-build-order-'));
    roots.push(home);
    const older = createPluginFixture(roots, { flavor: 'prod', version: '0.10.14' });
    const newer = createPluginFixture(roots, { flavor: 'prod', version: '0.10.16' });
    const registry = join(home, 'installed.json');
    writeFileSync(registry, JSON.stringify({ plugins: { 'coral@fixture': [{ installPath: newer.root }] } }));
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
    const supervisor = spawn(process.execPath, [harness, join(older.root, 'bridge', 'coral-backend.cjs')], {
      env: {
        ...process.env,
        HOME: home,
        TMPDIR: home,
        CORAL_SENTINEL_RUN_DIR: runDir,
        CORAL_PLUGIN_REGISTRY: registry,
      },
      stdio: 'ignore',
    });
    const record = new CoordinatorLaunchRecord(runDir);
    try {
      await waitForCondition(() => record.read().launch?.phase === 'serving', 20_000);
      expect(record.read().launch?.buildSetId).toBe(buildSetId(newer.root));
    } finally {
      const childPid = record.read().launch?.child?.pid;
      record.close();
      if (supervisor.exitCode === null) supervisor.kill('SIGKILL');
      if (childPid !== undefined) {
        try {
          process.kill(childPid, 'SIGKILL');
        } catch {
          // The child may have exited.
        }
      }
      for (const root of roots.reverse()) rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
  it('re-accepts an inherited request before completing it in the new owner epoch', async () => {
    const roots: string[] = [];
    const home = mkdtempSync(join(tmpdir(), 'coral-owner-epoch-request-'));
    roots.push(home);
    const plugin = createPluginFixture(roots, { flavor: 'prod' });
    const executable = join(plugin.root, 'bridge', 'coral-backend.cjs');
    const buildSetId = (
      JSON.parse(readFileSync(join(plugin.root, 'bridge', CURRENT_STRICT_BUNDLE_MANIFEST_FILE), 'utf8')) as {
        buildSetId: string;
      }
    ).buildSetId;
    const runDir = coordinatorPaths('prod', { baseDir: join(home, '.coral') }).runDir;
    const record = new CoordinatorLaunchRecord(runDir);
    const request = record.request(executable, buildSetId);
    const first = record.acquire(
      { id: 'first', process: { pid: process.pid, incarnation: 'first' as ProcessIncarnation }, buildSetId },
      Date.now(),
    );
    if (first === null) throw new Error('First owner did not acquire');
    expect(record.accept(first, request.id, Date.now())).toBe(true);
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
    const supervisor = spawn(process.execPath, [harness, executable], {
      env: { ...process.env, HOME: home, TMPDIR: home, CORAL_SENTINEL_RUN_DIR: runDir },
      stdio: 'ignore',
    });
    try {
      await waitForCondition(() => record.read().owner?.process.pid === supervisor.pid, 10_000);
      await waitForCondition(() => record.read().launch?.phase === 'serving', 20_000);
      await waitForCondition(
        () => record.read().requests.find((entry) => entry.id === request.id)?.status === 'completed',
        5_000,
      );
      expect(record.read().requests.find((entry) => entry.id === request.id)).toMatchObject({
        status: 'completed',
        acceptedEpoch: record.read().owner?.epoch,
      });
      const childPid = record.read().launch?.child?.pid;
      if (childPid === undefined) throw new Error('Serving child has no PID');
      process.kill(childPid, 'SIGINT');
      await waitForCondition(() => record.read().owner === null, 15_000);
      await waitForCondition(() => supervisor.exitCode !== null, 5_000);
    } finally {
      const childPid = record.read().launch?.child?.pid;
      record.close();
      if (supervisor.exitCode === null) supervisor.kill('SIGKILL');
      if (childPid !== undefined) {
        try {
          process.kill(childPid, 'SIGKILL');
        } catch {
          // The child may have exited.
        }
      }
      for (const root of roots.reverse()) rmSync(root, { recursive: true, force: true });
    }
  }, 35_000);
  it.each([
    { stall: 'an admitted child without hello', phase: 'before-hello', observed: 'admitted', refuseKill: false },
    {
      stall: 'a child that never claims admission',
      phase: 'before-admission',
      observed: 'reserved',
      refuseKill: false,
    },
    { stall: 'a refused SIGKILL', phase: 'before-hello', observed: 'admitted', refuseKill: true },
  ] as const)(
    'terminates $stall and serves from a fallback',
    async ({ phase, observed, refuseKill }) => {
      const roots: string[] = [];
      const home = mkdtempSync(join(tmpdir(), 'coral-no-first-hello-'));
      roots.push(home);
      const installed = createPluginFixture(roots, { flavor: 'prod', version: '0.10.16', backend: 'admission-freeze' });
      const fallback = createPluginFixture(roots, { flavor: 'prod', version: '0.10.13' });
      const fallbackBuildSetId = (
        JSON.parse(readFileSync(join(fallback.root, 'bridge', CURRENT_STRICT_BUNDLE_MANIFEST_FILE), 'utf8')) as {
          buildSetId: string;
        }
      ).buildSetId;
      const installedBuildSetId = (
        JSON.parse(readFileSync(join(installed.root, 'bridge', CURRENT_STRICT_BUNDLE_MANIFEST_FILE), 'utf8')) as {
          buildSetId: string;
        }
      ).buildSetId;
      const retained = join(home, '.coral', 'gen2', 'builds', fallbackBuildSetId);
      mkdirSync(join(retained, '..'), { recursive: true });
      renameSync(fallback.root, retained);
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
      const registry = join(home, 'installed.json');
      writeFileSync(registry, JSON.stringify({ plugins: { 'coral@fixture': [{ installPath: installed.root }] } }));
      const record = new CoordinatorLaunchRecord(runDir);
      record.request(join(installed.root, 'bridge', 'coral-backend.cjs'), installedBuildSetId);
      const supervisor = spawn(process.execPath, [harness, join(retained, 'bridge', 'coral-backend.cjs')], {
        env: {
          ...process.env,
          HOME: home,
          TMPDIR: home,
          CORAL_SENTINEL_RUN_DIR: runDir,
          CORAL_PLUGIN_REGISTRY: registry,
          CORAL_FIXTURE_STARTUP_BUDGET_MS: '1500',
          CORAL_FIXTURE_FREEZE_PHASE: phase,
          CORAL_FIXTURE_IGNORE_SIGTERM: refuseKill ? '1' : '0',
          CORAL_FIXTURE_REFUSE_KILL_ONCE: refuseKill ? '1' : '0',
        },
        stdio: 'ignore',
      });
      let stalledPid: number | undefined;
      try {
        await waitForCondition(
          () => record.read().launch?.phase === observed && record.read().launch?.buildSetId === installedBuildSetId,
          10_000,
        );
        stalledPid = record.read().launch?.child?.pid;
        if (refuseKill) {
          await waitForCondition(
            () => record.read().signalHolds?.some((hold) => hold.launchId === record.read().launch?.id) === true,
            8_000,
          );
        }
        try {
          await waitForCondition(
            () => record.read().launch?.phase === 'serving' && record.read().launch?.buildSetId === fallbackBuildSetId,
            15_000,
          );
        } catch (error: unknown) {
          throw new Error(`Fallback did not serve: ${JSON.stringify(record.read())}`, { cause: error });
        }
        expect(record.read().launch?.child?.pid).not.toBe(stalledPid);
        if (refuseKill) expect(record.read().signalHolds).toEqual([]);
      } finally {
        const currentPid = record.read().launch?.child?.pid;
        record.close();
        if (supervisor.exitCode === null) supervisor.kill('SIGKILL');
        for (const pid of [stalledPid, currentPid]) {
          if (pid === undefined) continue;
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            // The process may already have exited.
          }
        }
        for (const root of roots.reverse()) rmSync(root, { recursive: true, force: true });
      }
    },
    30_000,
  );

  it('escalates an explicit attempt retirement after a refused SIGTERM', async () => {
    const roots: string[] = [];
    const home = mkdtempSync(join(tmpdir(), 'coral-explicit-attempt-retirement-'));
    roots.push(home);
    const incumbent = createPluginFixture(roots, { flavor: 'prod', version: '0.10.14' });
    const target = createPluginFixture(roots, { flavor: 'prod', version: '0.10.16', backend: 'admission-freeze' });
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
    const supervisor = spawn(process.execPath, [harness, join(incumbent.root, 'bridge', 'coral-backend.cjs')], {
      env: {
        ...process.env,
        HOME: home,
        TMPDIR: home,
        CORAL_SENTINEL_RUN_DIR: runDir,
        CORAL_FIXTURE_IGNORE_SIGTERM: '1',
      },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    const record = new CoordinatorLaunchRecord(runDir);
    let attemptPid: number | undefined;
    try {
      await waitForCondition(() => record.read().launch?.phase === 'serving', 20_000);
      supervisor.send({
        fixtureChildMessage: {
          kind: 'coral-supervisor-start-attempt',
          attemptId: 'explicit-retirement',
          bundleDir: join(target.root, 'bridge'),
        },
      });
      await waitForCondition(() => record.read().attempt?.child !== undefined, 5_000);
      attemptPid = record.read().attempt?.child?.pid;
      supervisor.send({
        fixtureChildMessage: { kind: 'coral-supervisor-retire-attempt', attemptId: 'explicit-retirement' },
      });
      await waitForCondition(() => record.read().attempt?.phase === 'exited', 5_000);
      expect(record.read().signalHolds).toEqual([]);
    } finally {
      const incumbentPid = record.read().launch?.child?.pid;
      record.close();
      if (supervisor.exitCode === null) supervisor.kill('SIGKILL');
      for (const pid of [attemptPid, incumbentPid]) {
        if (pid === undefined) continue;
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          continue;
        }
      }
      for (const root of roots.reverse()) rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('dispatches a newer request after the serving build installation is removed', async () => {
    const roots: string[] = [];
    const home = mkdtempSync(join(tmpdir(), 'coral-removed-serving-root-'));
    roots.push(home);
    const original = createPluginFixture(roots, { flavor: 'prod', version: '0.10.14' });
    const target = createPluginFixture(roots, { flavor: 'prod', version: '0.10.16' });
    const originalBuildSetId = (
      JSON.parse(readFileSync(join(original.root, 'bridge', CURRENT_STRICT_BUNDLE_MANIFEST_FILE), 'utf8')) as {
        buildSetId: string;
      }
    ).buildSetId;
    const targetBuildSetId = (
      JSON.parse(readFileSync(join(target.root, 'bridge', CURRENT_STRICT_BUNDLE_MANIFEST_FILE), 'utf8')) as {
        buildSetId: string;
      }
    ).buildSetId;
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
      env: { ...process.env, HOME: home, TMPDIR: home, CORAL_SENTINEL_RUN_DIR: runDir },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let supervisorErrors = '';
    supervisor.stderr?.on('data', (chunk: Buffer) => {
      supervisorErrors += chunk.toString('utf8');
    });
    const record = new CoordinatorLaunchRecord(runDir);
    let firstPid: number | undefined;
    try {
      await waitForCondition(() => record.read().launch?.phase === 'serving', 20_000);
      firstPid = record.read().launch?.child?.pid;
      await waitForCondition(
        () => existsSync(join(home, '.coral', 'gen2', 'builds', originalBuildSetId, 'bridge', 'coral-backend.cjs')),
        10_000,
      );
      rmSync(original.root, { recursive: true, force: true });
      const request = record.request(join(target.root, 'bridge', 'coral-backend.cjs'), targetBuildSetId);
      try {
        await waitForCondition(
          () => record.read().requests.find((entry) => entry.id === request.id)?.status === 'completed',
          20_000,
        );
      } catch (error: unknown) {
        throw new Error(
          `Removed-root request did not complete: ${JSON.stringify(record.read())}\n${supervisorErrors}`,
          {
            cause: error,
          },
        );
      }
      expect(record.read().launch).toMatchObject({ phase: 'serving', buildSetId: targetBuildSetId });
    } finally {
      const currentPid = record.read().launch?.child?.pid;
      record.close();
      if (supervisor.exitCode === null) supervisor.kill('SIGKILL');
      for (const pid of [firstPid, currentPid]) {
        if (pid === undefined) continue;
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // The process may already have exited.
        }
      }
      for (const root of roots.reverse()) rmSync(root, { recursive: true, force: true });
    }
  }, 40_000);

  it('replaces its supervisor from the retained build after installation removal', async () => {
    const roots: string[] = [];
    const home = mkdtempSync(join(tmpdir(), 'coral-removed-supervisor-root-'));
    roots.push(home);
    const plugin = createPluginFixture(roots, { flavor: 'prod' });
    const buildSetId = (
      JSON.parse(readFileSync(join(plugin.root, 'bridge', CURRENT_STRICT_BUNDLE_MANIFEST_FILE), 'utf8')) as {
        buildSetId: string;
      }
    ).buildSetId;
    const retained = join(home, '.coral', 'gen2', 'builds', buildSetId);
    const heldRetained = join(home, 'held-retained-build');
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
    const supervisor = spawn(process.execPath, [harness, join(plugin.root, 'bridge', 'coral-backend.cjs')], {
      env: { ...process.env, HOME: home, TMPDIR: home, CORAL_SENTINEL_RUN_DIR: runDir },
      stdio: 'ignore',
    });
    const record = new CoordinatorLaunchRecord(runDir);
    let childPid: number | undefined;
    let replacementPid: number | undefined;
    try {
      await waitForCondition(() => record.read().launch?.phase === 'serving', 20_000);
      childPid = record.read().launch?.child?.pid;
      await waitForCondition(() => existsSync(join(retained, 'bridge', 'coral-sentinel.cjs')), 10_000);
      rmSync(plugin.root, { recursive: true, force: true });
      renameSync(retained, heldRetained);
      supervisor.kill('SIGKILL');
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      expect(record.read().owner?.process.pid).toBe(supervisor.pid);
      renameSync(heldRetained, retained);
      await waitForCondition(() => record.read().owner?.process.pid !== supervisor.pid, 15_000);
      replacementPid = record.read().owner?.process.pid;
      if (replacementPid === undefined) throw new Error('Replacement owner has no PID');
      const command = readFileSync(`/proc/${replacementPid}/cmdline`, 'utf8');
      expect(command).toContain(join(retained, 'bridge', 'coral-sentinel.cjs'));
      expect(record.read().launch).toMatchObject({ phase: 'serving', child: { pid: childPid } });
    } finally {
      if (existsSync(heldRetained)) renameSync(heldRetained, retained);
      record.close();
      if (supervisor.exitCode === null) supervisor.kill('SIGKILL');
      for (const pid of [childPid, replacementPid]) {
        if (pid === undefined) continue;
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // The process may already have exited.
        }
      }
      for (const root of roots.reverse()) rmSync(root, { recursive: true, force: true });
    }
  }, 40_000);

  it('reacquires an expired lease while it still parents the child and serves a pending request', async () => {
    const roots: string[] = [];
    const home = mkdtempSync(join(tmpdir(), 'coral-supervisor-lost-renewal-'));
    roots.push(home);
    const original = createPluginFixture(roots, { flavor: 'prod', version: '0.10.14' });
    const target = createPluginFixture(roots, { flavor: 'prod', version: '0.10.16' });
    const targetBuildSetId = (
      JSON.parse(readFileSync(join(target.root, 'bridge', CURRENT_STRICT_BUNDLE_MANIFEST_FILE), 'utf8')) as {
        buildSetId: string;
      }
    ).buildSetId;
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
      env: { ...process.env, HOME: home, TMPDIR: home, CORAL_SENTINEL_RUN_DIR: runDir },
      stdio: 'ignore',
    });
    const record = new CoordinatorLaunchRecord(runDir);
    let childPid: number | undefined;
    let successorPid: number | undefined;
    try {
      await waitForCondition(() => record.read().launch?.phase === 'serving', 20_000);
      childPid = record.read().launch?.child?.pid;
      if (childPid === undefined) throw new Error('Serving child has no PID');
      const database = new DatabaseSync(coordinatorLaunchPath(runDir));
      const row = database.prepare('SELECT state FROM control WHERE id = 1').get() as { state: string };
      const state = JSON.parse(row.state) as { owner: { leaseUntil: number } };
      state.owner.leaseUntil = Date.now() - 1;
      database.prepare('UPDATE control SET state = ? WHERE id = 1').run(JSON.stringify(state));
      database.close();
      record.request(join(target.root, 'bridge', 'coral-backend.cjs'), targetBuildSetId);
      process.kill(childPid, 'SIGINT');
      await waitForCondition(
        () => record.read().launch?.phase === 'serving' && record.read().launch?.buildSetId === targetBuildSetId,
        20_000,
      );
      successorPid = record.read().owner?.process.pid;
      expect(successorPid).toBe(supervisor.pid);
      expect(record.read().owner).toMatchObject({ epoch: 2, mode: 'supervised' });
    } finally {
      const currentChildPid = record.read().launch?.child?.pid;
      record.close();
      if (supervisor.exitCode === null) supervisor.kill('SIGKILL');
      for (const pid of [childPid, currentChildPid, successorPid]) {
        if (pid === undefined) continue;
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // The process may already have exited.
        }
      }
      for (const root of roots.reverse()) rmSync(root, { recursive: true, force: true });
    }
  }, 40_000);

  it('keeps a claimant alive across another supervisor lease expiry', async () => {
    const roots: string[] = [];
    const home = mkdtempSync(join(tmpdir(), 'coral-supervisor-claimant-'));
    roots.push(home);
    const original = createPluginFixture(roots, { flavor: 'prod', version: '0.10.14' });
    const target = createPluginFixture(roots, { flavor: 'prod', version: '0.10.16' });
    const targetBuildSetId = (
      JSON.parse(readFileSync(join(target.root, 'bridge', CURRENT_STRICT_BUNDLE_MANIFEST_FILE), 'utf8')) as {
        buildSetId: string;
      }
    ).buildSetId;
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
    const env = { ...process.env, HOME: home, TMPDIR: home, CORAL_SENTINEL_RUN_DIR: runDir };
    const incumbent = spawn(process.execPath, [harness, join(original.root, 'bridge', 'coral-backend.cjs')], {
      env,
      stdio: 'ignore',
    });
    const record = new CoordinatorLaunchRecord(runDir);
    let claimant: ReturnType<typeof spawn> | null = null;
    let childPid: number | undefined;
    try {
      await waitForCondition(() => record.read().launch?.phase === 'serving', 20_000);
      childPid = record.read().launch?.child?.pid;
      if (childPid === undefined) throw new Error('Serving child has no PID');
      incumbent.kill('SIGSTOP');
      const database = new DatabaseSync(coordinatorLaunchPath(runDir));
      const row = database.prepare('SELECT state FROM control WHERE id = 1').get() as { state: string };
      const state = JSON.parse(row.state) as { owner: { leaseUntil: number } };
      state.owner.leaseUntil = Date.now() + 1_000;
      database.prepare('UPDATE control SET state = ? WHERE id = 1').run(JSON.stringify(state));
      database.close();
      claimant = spawn(process.execPath, [harness, join(target.root, 'bridge', 'coral-backend.cjs')], {
        env,
        stdio: 'ignore',
      });
      await waitForCondition(
        () => record.read().requests.some((entry) => entry.buildSetId === targetBuildSetId),
        5_000,
      );
      expect(claimant.exitCode).toBeNull();
      await waitForCondition(() => record.read().owner?.process.pid === claimant?.pid, 5_000);
      incumbent.kill('SIGCONT');
      process.kill(childPid, 'SIGINT');
      await waitForCondition(
        () => record.read().launch?.phase === 'serving' && record.read().launch?.buildSetId === targetBuildSetId,
        20_000,
      );
      await waitForCondition(
        () => record.read().requests.find((entry) => entry.buildSetId === targetBuildSetId)?.status === 'completed',
        5_000,
      );
    } finally {
      const currentChildPid = record.read().launch?.child?.pid;
      record.close();
      incumbent.kill('SIGCONT');
      if (incumbent.exitCode === null) incumbent.kill('SIGKILL');
      if (claimant !== null && claimant.exitCode === null) claimant.kill('SIGKILL');
      for (const pid of [childPid, currentChildPid]) {
        if (pid === undefined) continue;
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // The child may already have exited.
        }
      }
      for (const root of roots.reverse()) rmSync(root, { recursive: true, force: true });
    }
  }, 40_000);

  it('repairs supervision into the same build without an upgrade request', async () => {
    const roots: string[] = [];
    const home = mkdtempSync(join(tmpdir(), 'coral-supervisor-loss-'));
    roots.push(home);
    const plugin = createPluginFixture(roots, { flavor: 'prod' });
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
    const supervisor = spawn(process.execPath, [harness, join(plugin.root, 'bridge', 'coral-backend.cjs')], {
      env: { ...process.env, HOME: home, TMPDIR: home, CORAL_SENTINEL_RUN_DIR: runDir },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let coordinatorErrors = '';
    supervisor.stderr?.on('data', (chunk: Buffer) => {
      coordinatorErrors += chunk.toString('utf8');
    });
    const record = new CoordinatorLaunchRecord(runDir);
    let childPid: number | undefined;
    let replacementPid: number | undefined;
    let repairedPid: number | undefined;
    try {
      await waitForCondition(() => record.read().launch?.phase === 'serving', 20_000);
      childPid = record.read().launch?.child?.pid;
      if (childPid === undefined) throw new Error('Serving coordinator has no PID');
      supervisor.kill('SIGKILL');
      await waitForCondition(() => record.read().owner?.process.pid !== supervisor.pid, 10_000);
      replacementPid = record.read().owner?.process.pid;
      expect(record.read().launch).toMatchObject({ phase: 'serving', child: { pid: childPid } });
      expect(() => process.kill(childPid!, 0)).not.toThrow();
      try {
        await waitForCondition(
          () =>
            record.read().launch?.phase === 'serving' &&
            record.read().launch?.child?.pid !== childPid &&
            record.read().owner?.mode === 'supervised',
          25_000,
        );
      } catch (error: unknown) {
        throw new Error(
          `Same-build repair did not serve: ${JSON.stringify(record.read())}; intent=${JSON.stringify(readUpgradeIntent(runDir))}; stderr=${coordinatorErrors
            .split('\n')
            .filter((line) => /repair|supervisor/i.test(line))
            .slice(-10)
            .join('\n')}`,
          { cause: error },
        );
      }
      repairedPid = record.read().launch?.child?.pid;
      expect(record.read().launch?.parent).toEqual(record.read().owner?.process);
      if (repairedPid === undefined) throw new Error('Repaired coordinator has no PID');
      process.kill(repairedPid, 'SIGINT');
      try {
        await waitForCondition(() => record.read().owner === null, 20_000);
      } catch (error: unknown) {
        throw new Error(`Replacement did not retire: ${JSON.stringify(record.read())}`, { cause: error });
      }
      expect(record.read().launch?.phase).toBe('exited');
    } finally {
      record.close();
      if (supervisor.exitCode === null) supervisor.kill('SIGKILL');
      for (const pid of [childPid, replacementPid, repairedPid]) {
        if (pid === undefined) continue;
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // The process may already have exited.
        }
      }
      for (const root of roots.reverse()) rmSync(root, { recursive: true, force: true });
    }
  }, 40_000);

  it('repairs supervision before a format-blocked upgrade while its job stays live', async () => {
    const roots: string[] = [];
    const home = mkdtempSync(join(tmpdir(), 'coral-blocked-supervision-repair-'));
    roots.push(home);
    const incumbent = createPluginFixture(roots, { flavor: 'prod', version: '0.10.14', accepts: 'bundled' });
    const upgrade = createPluginFixture(roots, { flavor: 'prod', version: '0.10.15', accepts: 'bundled' });
    const bridge = join(upgrade.root, 'bridge');
    const strictPath = join(bridge, CURRENT_STRICT_BUNDLE_MANIFEST_FILE);
    const strict = JSON.parse(readFileSync(strictPath, 'utf8')) as {
      version: string;
      buildSetId: string;
      flavor: string;
      storeFormatFingerprint: string;
      bundleHash: string;
      cliBundleHash: string;
      claudeAppserverBundleHash: string;
      durableWrapperBundleHash: string;
    };
    const oldFingerprint = strict.storeFormatFingerprint;
    const backendPath = join(bridge, 'coral-backend.cjs');
    const buildChangingBackend = async (): Promise<void> => {
      await build({
        entryPoints: [join(process.cwd(), 'tests', 'fixtures', 'durable-succession-provider.ts')],
        outfile: backendPath,
        bundle: true,
        platform: 'node',
        target: 'node22',
        format: 'cjs',
        external: ['node:*', '@lydell/node-pty'],
        loader: { '.sql': 'text' },
        minify: true,
        plugins: [
          {
            name: 'schema-changing-fixture',
            setup(builder: PluginBuild) {
              builder.onLoad({ filter: /schema\.sql$/ }, (args) => ({
                contents: `${readFileSync(args.path, 'utf8')}\nCREATE TABLE repair_test_generation (id INTEGER PRIMARY KEY);\n`,
                loader: 'text',
              }));
            },
          },
        ],
        banner: {
          js:
            `var __CORAL_BUILD_IDENTITY__=${JSON.stringify({
              version: strict.version,
              buildSetId: strict.buildSetId,
              flavor: strict.flavor,
              storeFormatFingerprint: strict.storeFormatFingerprint,
            })};` +
            'var __PLUGIN_ROOT__=require("path").resolve(__dirname,"..");' +
            'var __BUNDLE_DIR__=__dirname;' +
            'var __importMetaUrl=require("url").pathToFileURL(__filename).href;',
        },
        define: {
          __VERSION__: JSON.stringify(strict.version),
          __BUILD_SET_ID__: JSON.stringify(strict.buildSetId),
          __BUILD_FLAVOR__: JSON.stringify(strict.flavor),
          __STORE_FORMAT_FINGERPRINT__: JSON.stringify(strict.storeFormatFingerprint),
          __IS_CORAL_BACKEND_MAIN__: 'true',
          'import.meta.url': '__importMetaUrl',
        },
      });
    };
    await buildChangingBackend();
    strict.storeFormatFingerprint = execFileSync(process.execPath, [backendPath, '--print-store-format-fingerprint'], {
      encoding: 'utf8',
    }).trim();
    expect(strict.storeFormatFingerprint).not.toBe(oldFingerprint);
    await buildChangingBackend();
    for (const [name, hashKey] of [
      ['coral-cli', 'cliBundleHash'],
      ['coral-claude-appserver.cjs', 'claudeAppserverBundleHash'],
      ['coral-durable-wrapper.cjs', 'durableWrapperBundleHash'],
    ] as const) {
      const path = join(bridge, name);
      writeFileSync(path, readFileSync(path, 'utf8').replaceAll(oldFingerprint, strict.storeFormatFingerprint));
      strict[hashKey] = createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 16);
    }
    strict.bundleHash = createHash('sha256').update(readFileSync(backendPath)).digest('hex').slice(0, 16);
    writeFileSync(strictPath, `${JSON.stringify(strict)}\n`);
    writeFileSync(join(bridge, 'manifest.json'), `${JSON.stringify(strict)}\n`);
    const capabilitiesPath = join(bridge, SUCCESSION_CAPABILITIES_FILE);
    const capabilities = JSON.parse(readFileSync(capabilitiesPath, 'utf8')) as { bundleHash: string };
    capabilities.bundleHash = strict.bundleHash;
    writeFileSync(capabilitiesPath, `${JSON.stringify(capabilities)}\n`);
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
    const binDir = join(home, 'bin');
    const stateDir = join(home, '.fake-codex-state');
    const projectRoot = join(home, 'project');
    mkdirSync(binDir);
    mkdirSync(stateDir);
    mkdirSync(projectRoot);
    mkdirSync(join(home, '.codex'));
    mkdirSync(join(home, '.claude'));
    writeFileSync(
      join(home, '.codex', 'auth.json'),
      JSON.stringify({ tokens: { access_token: 'fake-access-token', account_id: 'fake-account-id' } }),
    );
    const fakeCodex = join(binDir, 'codex');
    copyFileSync(join(process.cwd(), 'tests', 'fixtures', 'transfer-codex-appserver.cjs'), fakeCodex);
    chmodSync(fakeCodex, 0o755);
    const supervisor = spawn(process.execPath, [harness, join(incumbent.root, 'bridge', 'coral-backend.cjs')], {
      env: {
        ...process.env,
        HOME: home,
        TMPDIR: home,
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
        CORAL_SENTINEL_RUN_DIR: runDir,
      },
      stdio: 'ignore',
    });
    const record = new CoordinatorLaunchRecord(runDir);
    const pids = new Set<number>();
    let cli: ReturnType<typeof spawn> | null = null;
    try {
      await waitForCondition(() => record.read().launch?.phase === 'serving', 20_000);
      const originalPid = record.read().launch?.child?.pid;
      if (originalPid === undefined) throw new Error('Serving coordinator has no PID');
      pids.add(originalPid);
      const prompt = join(projectRoot, 'prompt.txt');
      writeFileSync(prompt, 'Keep this job running through supervisor replacement.');
      cli = spawn('node', [join(incumbent.root, 'bridge', 'coral-cli'), 'codex', '-i', prompt, '--detach'], {
        cwd: projectRoot,
        env: topLevelCliEnvironment(home, { PATH: `${binDir}:${process.env.PATH ?? ''}` }),
        stdio: 'ignore',
      });
      await waitForCondition(() => cli?.exitCode !== null && existsSync(join(stateDir, 'job-running')), 30_000);
      expect(cli.exitCode).toBe(0);
      const jobPid = Number(readFileSync(join(stateDir, 'job-running'), 'utf8'));
      const jobIncarnation = probeProcessIncarnation(jobPid);
      if (jobIncarnation === null) throw new Error('Provider job process has no incarnation');
      const requested = record.request(join(upgrade.root, 'bridge', 'coral-backend.cjs'), buildSetId(upgrade.root));
      try {
        await waitForCondition(() => {
          const intent = readUpgradeIntent(runDir);
          return (
            intent.kind === 'readable' &&
            intent.intent.blockers.some((blocker) => blocker.reason.includes('blocking(format)'))
          );
        }, 20_000);
      } catch (error: unknown) {
        throw new Error(
          `Format blocker was not recorded: ${JSON.stringify(readUpgradeIntent(runDir))}; launch=${JSON.stringify(record.read())}`,
          { cause: error },
        );
      }
      supervisor.kill('SIGKILL');
      await waitForCondition(() => record.read().owner?.process.pid !== supervisor.pid, 10_000);
      const replacementPid = record.read().owner?.process.pid;
      if (replacementPid === undefined) throw new Error('Replacement supervisor has no PID');
      pids.add(replacementPid);
      try {
        await waitForCondition(
          () =>
            record.read().launch?.phase === 'serving' &&
            record.read().launch?.child?.pid !== originalPid &&
            record.read().launch?.buildSetId === buildSetId(incumbent.root) &&
            record.read().launch?.parent?.pid === replacementPid &&
            record.read().owner?.mode === 'supervised',
          25_000,
        );
      } catch (error: unknown) {
        throw new Error(
          `Same-build repair did not serve: ${JSON.stringify(record.read())}; intent=${JSON.stringify(readUpgradeIntent(runDir))}`,
          { cause: error },
        );
      }
      const intent = readUpgradeIntent(runDir);
      expect(intent.kind).toBe('readable');
      if (intent.kind !== 'readable') throw new Error('Queued upgrade intent is unavailable');
      expect(intent.intent.target.build.buildSetId).toBe(buildSetId(upgrade.root));
      expect(intent.intent.disposition).toBe('deferred');
      expect(intent.intent.blockers.some((blocker) => blocker.reason.includes('blocking(format)'))).toBe(true);
      expect(record.read().requests.find((entry) => entry.id === requested.id)?.status).not.toBe('completed');
      expect(probeProcessIncarnation(jobPid)).toBe(jobIncarnation);
      writeFileSync(join(stateDir, 'release-job'), '');
      await waitForCondition(() => existsSync(join(stateDir, 'terminal-completed')), 20_000);
      await waitForCondition(() => record.read().attempt?.buildSetId === buildSetId(upgrade.root), 20_000);
    } finally {
      const state = record.read();
      for (const pid of [state.owner?.process.pid, state.launch?.child?.pid, state.attempt?.child?.pid]) {
        if (pid !== undefined) pids.add(pid);
      }
      record.close();
      cli?.kill('SIGKILL');
      supervisor.kill('SIGKILL');
      for (const pid of pids) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // The process may already have exited.
        }
      }
      const jobPath = join(stateDir, 'job-running');
      if (existsSync(jobPath)) {
        try {
          process.kill(Number(readFileSync(jobPath, 'utf8')), 'SIGKILL');
        } catch {
          // The provider job may already have exited.
        }
      }
      for (const root of roots.reverse()) rmSync(root, { recursive: true, force: true });
    }
  }, 70_000);

  it('keeps ownership after an unconfirmed replacement fails and serves from a retained fallback', async () => {
    const roots: string[] = [];
    const home = mkdtempSync(join(tmpdir(), 'coral-supervisor-recovery-'));
    roots.push(home);
    const installed = createPluginFixture(roots, { flavor: 'prod', backend: 'sentinel-freeze', version: '0.10.16' });
    const original = createPluginFixture(roots, { flavor: 'prod', backend: 'sentinel-freeze', version: '0.10.13' });
    const manifest = JSON.parse(
      readFileSync(join(original.root, 'bridge', CURRENT_STRICT_BUNDLE_MANIFEST_FILE), 'utf8'),
    ) as {
      buildSetId: string;
    };
    const retained = join(home, '.coral', 'gen2', 'builds', manifest.buildSetId);
    mkdirSync(join(retained, '..'), { recursive: true });
    renameSync(original.root, retained);
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
    const registry = join(home, 'installed.json');
    writeFileSync(registry, JSON.stringify({ plugins: { 'coral@fixture': [{ installPath: installed.root }] } }));
    const supervisor = spawn(process.execPath, [harness, join(retained, 'bridge', 'coral-backend.cjs')], {
      env: {
        ...process.env,
        HOME: home,
        TMPDIR: home,
        CORAL_SENTINEL_RUN_DIR: runDir,
        CORAL_PLUGIN_REGISTRY: registry,
        CORAL_FIXTURE_FAIL_INSTALLED_ROOTS: installed.root,
        CORAL_FIXTURE_FAIL_AFTER_MS: '16000',
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    const record = new CoordinatorLaunchRecord(runDir);
    let firstPid: number | null = null;
    let finalPid: number | null = null;
    try {
      await waitForCondition(() => existsSync(join(runDir, 'coordinator.json')), 20_000);
      firstPid = (JSON.parse(readFileSync(join(runDir, 'coordinator.json'), 'utf8')) as { pid: number }).pid;
      supervisor.send({ kind: 'freeze-coordinator' });
      await waitForCondition(
        () => record.read().launch?.buildSetId !== manifest.buildSetId && record.read().launch?.phase === 'admitted',
        10_000,
      );
      await new Promise((resolve) => setTimeout(resolve, 15_500));
      expect(supervisor.exitCode).toBeNull();
      expect(record.read().launch).toMatchObject({ phase: 'admitted' });
      await waitForCondition(() => {
        if (!existsSync(join(runDir, 'coordinator.json'))) return false;
        const pid = (JSON.parse(readFileSync(join(runDir, 'coordinator.json'), 'utf8')) as { pid: number }).pid;
        if (pid === firstPid) return false;
        if (record.read().launch?.buildSetId !== manifest.buildSetId || record.read().launch?.phase !== 'serving')
          return false;
        finalPid = pid;
        return true;
      }, 20_000);
      expect(supervisor.exitCode).toBeNull();
    } finally {
      record.close();
      if (supervisor.exitCode === null) supervisor.kill('SIGTERM');
      for (const pid of [firstPid, finalPid]) {
        if (pid === null) continue;
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          /* fixture already exited */
        }
      }
      for (const root of roots.reverse()) rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
  it('chooses the newest eligible request after a starting coordinator exits', async () => {
    const roots: string[] = [];
    const home = mkdtempSync(join(tmpdir(), 'coral-red-supervisor-version-order-'));
    roots.push(home);
    const starting = createPluginFixture(roots, { flavor: 'prod', version: '0.10.14', backend: 'sentinel-freeze' });
    const rollback = createPluginFixture(roots, {
      flavor: 'prod',
      version: '0.10.13',
      backend: 'admission-freeze',
    });
    const upgrade = createPluginFixture(roots, { flavor: 'prod', version: '0.10.16' });
    const registry = join(home, 'installed.json');
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
    const supervisor = spawn(process.execPath, [harness, join(starting.root, 'bridge', 'coral-backend.cjs')], {
      env: {
        ...process.env,
        HOME: home,
        TMPDIR: home,
        CORAL_SENTINEL_RUN_DIR: runDir,
        CORAL_PLUGIN_REGISTRY: registry,
        CORAL_FIXTURE_FAIL_INSTALLED_ROOTS: starting.root,
        CORAL_FIXTURE_FAIL_AFTER_MS: '3000',
      },
      stdio: 'ignore',
    });
    const record = new CoordinatorLaunchRecord(runDir);
    try {
      await waitForCondition(() => record.read().launch?.phase === 'admitted', 10_000);
      writeFileSync(registry, JSON.stringify({ plugins: { 'coral@fixture': [{ installPath: upgrade.root }] } }));
      record.request(join(rollback.root, 'bridge', 'coral-backend.cjs'), buildSetId(rollback.root));
      record.request(join(upgrade.root, 'bridge', 'coral-backend.cjs'), buildSetId(upgrade.root));

      await waitForCondition(() => record.read().launch?.buildSetId !== buildSetId(starting.root), 20_000);

      expect(record.read().launch?.buildSetId).toBe(buildSetId(upgrade.root));
    } finally {
      const childPid = record.read().launch?.child?.pid;
      record.close();
      if (supervisor.exitCode === null) supervisor.kill('SIGKILL');
      if (childPid !== undefined) {
        try {
          process.kill(childPid, 'SIGKILL');
        } catch {
          // The fixture may already have exited.
        }
      }
      for (const root of roots.reverse()) rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('reaps an inherited admitted child after its parent supervisor crashes', async () => {
    const roots: string[] = [];
    const home = mkdtempSync(join(tmpdir(), 'coral-red-inherited-admission-'));
    roots.push(home);
    const stalled = createPluginFixture(roots, { flavor: 'prod', version: '0.10.14', backend: 'admission-freeze' });
    const recovery = createPluginFixture(roots, { flavor: 'prod', version: '0.10.16' });
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
    const env = {
      ...process.env,
      HOME: home,
      TMPDIR: home,
      CORAL_SENTINEL_RUN_DIR: runDir,
      CORAL_FIXTURE_STARTUP_BUDGET_MS: '1500',
    };
    const parent = spawn(process.execPath, [harness, join(stalled.root, 'bridge', 'coral-backend.cjs')], {
      env,
      stdio: 'ignore',
    });
    const record = new CoordinatorLaunchRecord(runDir);
    let replacement: ReturnType<typeof spawn> | null = null;
    let stalledPid: number | undefined;
    try {
      await waitForCondition(() => record.read().launch?.phase === 'admitted', 10_000);
      const admittedAt = record.read().launch?.admittedAt;
      if (admittedAt === undefined) throw new Error('Admitted child has no admission time');
      stalledPid = record.read().launch?.child?.pid;
      if (stalledPid === undefined) throw new Error('Admitted child has no PID');
      parent.kill('SIGKILL');

      replacement = spawn(process.execPath, [harness, join(recovery.root, 'bridge', 'coral-backend.cjs')], {
        env,
        stdio: 'ignore',
      });
      await waitForCondition(() => record.read().owner?.process.pid === replacement?.pid, 10_000);
      expect(record.read().launch?.admittedAt).toBe(admittedAt);
      await waitForCondition(
        () =>
          record.read().launch?.phase === 'serving' && record.read().launch?.buildSetId === buildSetId(recovery.root),
        10_000,
      );
    } finally {
      const currentPid = record.read().launch?.child?.pid;
      record.close();
      const replacementProcess = replacement;
      const parentExit =
        parent.exitCode === null && parent.signalCode === null
          ? new Promise<void>((resolve) => parent.once('exit', () => resolve()))
          : Promise.resolve();
      const replacementExit =
        replacementProcess !== null && replacementProcess.exitCode === null && replacementProcess.signalCode === null
          ? new Promise<void>((resolve) => replacementProcess.once('exit', () => resolve()))
          : Promise.resolve();
      if (parent.exitCode === null && parent.signalCode === null) parent.kill('SIGKILL');
      if (replacementProcess !== null && replacementProcess.exitCode === null && replacementProcess.signalCode === null)
        replacementProcess.kill('SIGKILL');
      await Promise.all([parentExit, replacementExit]);
      for (const pid of [stalledPid, currentPid]) {
        if (pid === undefined) continue;
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // The fixture may already have exited.
        }
      }
      for (const root of roots.reverse()) rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);

  it.each([
    { phase: 'accepted recovery', removeInstallation: false },
    { phase: 'accepted recovery', removeInstallation: true },
    { phase: 'promotion', removeInstallation: false },
    { phase: 'promotion', removeInstallation: true },
  ] as const)(
    'restores supervision after replacement death following $phase (removed installation: $removeInstallation)',
    async ({ phase, removeInstallation }) => {
      const roots: string[] = [];
      const home = mkdtempSync(join(tmpdir(), 'coral-recovery-repeated-crash-'));
      roots.push(home);
      const plugin = createPluginFixture(roots, { flavor: 'prod', version: '0.10.14' });
      const expectedBuildSetId = buildSetId(plugin.root);
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
      const supervisor = spawn(process.execPath, [harness, join(plugin.root, 'bridge', 'coral-backend.cjs')], {
        env: { ...process.env, HOME: home, TMPDIR: home, CORAL_SENTINEL_RUN_DIR: runDir },
        stdio: 'ignore',
      });
      const record = new CoordinatorLaunchRecord(runDir);
      const pids = new Set<number>();
      const remember = (): ReturnType<typeof record.read> => {
        const state = record.read();
        for (const process of [
          state.owner?.process,
          state.launch?.parent,
          state.launch?.child,
          state.attempt?.parent,
          state.attempt?.child,
        ])
          if (process !== undefined) pids.add(process.pid);
        return state;
      };
      try {
        await waitForCondition(() => remember().launch?.phase === 'serving', 20_000);
        const firstChild = remember().launch?.child?.pid;
        if (firstChild === undefined) throw new Error('Initial coordinator has no PID');
        const retained = join(home, '.coral', 'gen2', 'builds', expectedBuildSetId, 'bridge', 'coral-backend.cjs');
        await waitForCondition(() => existsSync(retained), 10_000);
        if (removeInstallation) rmSync(plugin.root, { recursive: true, force: true });
        supervisor.kill('SIGKILL');
        await waitForCondition(() => {
          const state = remember();
          return state.owner?.process.pid !== supervisor.pid && state.owner?.mode === 'recovering';
        }, 15_000);
        let doomedChild = firstChild;
        if (phase === 'promotion') {
          await waitForCondition(() => {
            const state = remember();
            return (
              state.launch?.phase === 'serving' &&
              state.launch.child?.pid !== firstChild &&
              state.owner?.mode === 'supervised'
            );
          }, 25_000);
          doomedChild = remember().launch?.child?.pid ?? firstChild;
        }
        const doomedSupervisor = remember().owner?.process.pid;
        if (doomedSupervisor === undefined) throw new Error('Replacement has no PID');
        process.kill(doomedSupervisor, 'SIGKILL');
        await waitForCondition(() => {
          const state = remember();
          return (
            state.launch?.phase === 'serving' &&
            state.launch.child?.pid !== doomedChild &&
            state.owner?.process.pid !== doomedSupervisor &&
            state.owner?.mode === 'supervised'
          );
        }, 40_000);
        const final = remember();
        expect(final.launch?.parent).toEqual(final.owner?.process);
        expect(final.launch?.buildSetId).toBe(expectedBuildSetId);
        expect(
          final.requests.every((request) => request.status === 'completed' || request.status === 'unavailable'),
        ).toBe(true);
      } finally {
        remember();
        record.close();
        if (supervisor.exitCode === null) supervisor.kill('SIGKILL');
        for (const pid of pids) {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            // The test process may already have exited.
          }
        }
        for (const root of roots.reverse()) rmSync(root, { recursive: true, force: true });
      }
    },
    75_000,
  );
});
