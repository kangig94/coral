import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

import { CoordinatorLaunchRecord } from '#src/infra/coordinator-launch.js';
import { CURRENT_STRICT_BUNDLE_MANIFEST_FILE } from '#src/infra/bundle-manifest-address.js';
import { coordinatorPaths } from '#src/infra/path/coordinator.js';
import { coordinatorLaunchPath } from '#src/infra/path/index.js';
import { createPluginFixture } from '#tests/integration/coordinator/helpers.js';
import { waitForCondition } from '#tests/support/wait-for-condition.js';

describe('namespace supervisor recovery', () => {
  it.each([
    { stall: 'an admitted child without hello', phase: 'before-hello', observed: 'admitted' },
    { stall: 'a child that never claims admission', phase: 'before-admission', observed: 'reserved' },
  ] as const)(
    'terminates $stall and serves from a fallback',
    async ({ phase, observed }) => {
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
        try {
          await waitForCondition(
            () => record.read().launch?.phase === 'serving' && record.read().launch?.buildSetId === fallbackBuildSetId,
            15_000,
          );
        } catch (error: unknown) {
          throw new Error(`Fallback did not serve: ${JSON.stringify(record.read())}`, { cause: error });
        }
        expect(record.read().launch?.child?.pid).not.toBe(stalledPid);
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

  it('starts a successor when its own lease renewal fails with a pending request', async () => {
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
      expect(successorPid).not.toBe(supervisor.pid);
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
      expect(record.read().requests.find((entry) => entry.buildSetId === targetBuildSetId)?.status).toBe('completed');
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

  it('replaces a dead supervisor while its coordinator keeps serving, then exits after idle retirement', async () => {
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
      stdio: 'ignore',
    });
    const record = new CoordinatorLaunchRecord(runDir);
    let childPid: number | undefined;
    let replacementPid: number | undefined;
    try {
      await waitForCondition(() => record.read().launch?.phase === 'serving', 20_000);
      childPid = record.read().launch?.child?.pid;
      if (childPid === undefined) throw new Error('Serving coordinator has no PID');
      supervisor.kill('SIGKILL');
      await waitForCondition(() => record.read().owner?.process.pid !== supervisor.pid, 10_000);
      replacementPid = record.read().owner?.process.pid;
      expect(record.read().launch).toMatchObject({ phase: 'serving', child: { pid: childPid } });
      expect(() => process.kill(childPid!, 0)).not.toThrow();
      process.kill(childPid, 'SIGINT');
      try {
        await waitForCondition(() => record.read().owner === null, 20_000);
      } catch (error: unknown) {
        throw new Error(`Replacement did not retire: ${JSON.stringify(record.read())}`, { cause: error });
      }
      expect(record.read().launch?.phase).toBe('exited');
    } finally {
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
});
