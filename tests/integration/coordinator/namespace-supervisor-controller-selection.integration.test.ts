import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

import { SupervisorEvidence } from '#tests/support/supervisor-evidence.js';
import { probeProcessIncarnation } from '#src/infra/node-process.js';
import { CURRENT_STRICT_BUNDLE_MANIFEST_FILE } from '#src/infra/bundle-manifest-address.js';
import { coordinatorPaths } from '#src/infra/path/coordinator.js';
import { providerHandoffCapsulePath } from '#src/infra/path/provider-proxy.js';
import { handoffCapsuleV1Schema } from '#src/provider-proxy/handoff-capsule.js';
import { createPluginFixture, createShippedPluginFixture } from '#tests/integration/coordinator/helpers.js';
import { validatedBuild } from '#src/coordinator-launch/selection.js';
import { controllerBuild } from '#src/coordinator-launch/controller-build.js';
import { JobLocationIndex } from '#src/jobs/location-index.js';
import { createRealRuntime } from '#src/runtime/real.js';
import {
  custodyLedgerDir,
  recordCustodyIntent,
  readCustodyLedger,
  reconcileCustodyLedger,
} from '#src/store/custody-ledger.js';
import { waitForCondition } from '#tests/support/wait-for-condition.js';
import { supervisorAcceptedUpgrade } from '#src/transport/ipc/ensure.js';

function fixtureBuildSetId(root: string): string {
  return (
    JSON.parse(readFileSync(join(root, 'bridge', CURRENT_STRICT_BUNDLE_MANIFEST_FILE), 'utf8')) as {
      buildSetId: string;
    }
  ).buildSetId;
}

describe('namespace supervisor controller selection', () => {
  it('keeps the same CLI invocation through a failed first child', async () => {
    const roots: string[] = [];
    const home = mkdtempSync(join(tmpdir(), 'coral-child-setup-recovery-'));
    roots.push(home);
    const plugin = createPluginFixture(roots, { flavor: 'prod', backend: 'setup-error-once' });
    const runDir = coordinatorPaths('prod', { baseDir: join(home, '.coral') }).runDir;
    const record = new SupervisorEvidence(runDir);
    const cli = spawn(process.execPath, [join(plugin.root, 'bridge', 'coral-cli'), 'backend', 'start'], {
      cwd: home,
      env: {
        ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('CORAL_'))),
        HOME: home,
        TMPDIR: home,
        CLAUDE_PLUGIN_ROOT: plugin.root,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    cli.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()));
    cli.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()));
    try {
      try {
        await waitForCondition(() => cli.exitCode !== null, 30_000);
      } catch (error: unknown) {
        throw new Error(`CLI did not finish: ${output}; ${JSON.stringify(record.read())}`, { cause: error });
      }
      expect(cli.exitCode, output).toBe(0);
      expect(existsSync(join(runDir, 'setup-error-once.fixture'))).toBe(true);
      await waitForCondition(() => record.read().launch?.phase === 'serving', 10_000);
      expect(record.read().launch).toMatchObject({ phase: 'serving', buildSetId: fixtureBuildSetId(plugin.root) });
    } finally {
      const state = record.read();
      record.close();
      if (cli.exitCode === null) cli.kill('SIGKILL');
      for (const pid of [state.owner?.process.pid, state.launch?.child?.pid]) {
        if (pid === undefined) continue;
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // The fixture may already have exited.
        }
      }
      for (const root of roots.reverse()) rmSync(root, { recursive: true, force: true });
    }
  }, 40_000);
  it('holds selection when an unresolved job has unreadable custody', () => {
    const home = mkdtempSync(join(tmpdir(), 'coral-unreadable-controller-'));
    try {
      const baseDir = join(home, '.coral');
      const runtime = createRealRuntime('prod', { baseDir });
      const runDir = runtime.paths.coral.coordinator.runDir;
      const index = new JobLocationIndex(runtime, runtime.paths.coral.generation.dataRoot);
      index.register('unresolved-job', 'epoch-1', {
        projectRoot: home,
        workDir: home,
        jobKind: 'provider',
      });
      mkdirSync(join(custodyLedgerDir(runDir), 'unreadable-entry'), { recursive: true });
      expect(controllerBuild(runDir)).toEqual({ kind: 'unknown' });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
  it('holds launch selection when custody inventory is unreadable before any job location is indexed', () => {
    const home = mkdtempSync(join(tmpdir(), 'coral-unreadable-unindexed-custody-'));
    try {
      const runDir = coordinatorPaths('prod', { baseDir: join(home, '.coral') }).runDir;
      mkdirSync(join(custodyLedgerDir(runDir), 'unreadable-entry'), { recursive: true });
      expect(controllerBuild(runDir)).toEqual({ kind: 'unknown' });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
  it('launches and repairs a damaged absence receipt without hiding its valid custody intent', async () => {
    const roots: string[] = [];
    const home = mkdtempSync(join(tmpdir(), 'coral-damaged-absence-boot-'));
    roots.push(home);
    const plugin = createPluginFixture(roots, { flavor: 'prod' });
    const runtime = createRealRuntime('prod', { baseDir: join(home, '.coral') });
    const runDir = runtime.paths.coral.coordinator.runDir;
    const intent = recordCustodyIntent(runtime, runDir, {
      effect: 'process-spawn',
      epoch: join(home, 'never-created-epoch'),
      owner: 'durable-cli',
      operationId: 'never-spawned-job',
      capsule: null,
      nowMs: 1,
      bindWithinMs: 1,
    });
    const receipt = join(custodyLedgerDir(runDir), intent.id, 'absence.v1.json');
    writeFileSync(receipt, '{');
    expect(controllerBuild(runDir)).toEqual({ kind: 'none' });
    expect(readCustodyLedger(runtime, runDir)).toMatchObject([{ kind: 'holding', intent }]);
    const record = new SupervisorEvidence(runDir);
    const supervisor = spawn(
      process.execPath,
      [join(plugin.root, 'bridge', 'coral-sentinel.cjs'), join(plugin.root, 'bridge', 'coral-backend.cjs')],
      {
        env: { ...process.env, HOME: home, TMPDIR: home, CORAL_SENTINEL_RUN_DIR: runDir },
        stdio: 'ignore',
      },
    );
    try {
      await waitForCondition(() => record.read().launch?.phase === 'serving', 15_000);
      await waitForCondition(() => readCustodyLedger(runtime, runDir).some((entry) => entry.kind === 'absent'), 5_000);
      expect(readCustodyLedger(runtime, runDir)).toMatchObject([{ kind: 'absent', intent }]);
      expect(JSON.parse(readFileSync(receipt, 'utf8'))).toMatchObject({ processToken: intent.processToken });
    } finally {
      const state = record.read();
      record.close();
      supervisor.kill('SIGKILL');
      if (state.launch?.child?.pid !== undefined) {
        try {
          process.kill(state.launch.child.pid, 'SIGKILL');
        } catch {
          /* The fixture may have exited. */
        }
      }
      for (const root of roots.reverse()) rmSync(root, { recursive: true, force: true });
    }
  });

  it('records unreadable custody quarantine and launches after the record is repaired', async () => {
    const roots: string[] = [];
    const home = mkdtempSync(join(tmpdir(), 'coral-custody-quarantine-'));
    roots.push(home);
    const plugin = createPluginFixture(roots, { flavor: 'prod', version: '0.10.14' });
    const runDir = coordinatorPaths('prod', { baseDir: join(home, '.coral') }).runDir;
    const unreadablePath = join(custodyLedgerDir(runDir), 'unreadable-entry');
    mkdirSync(unreadablePath, { recursive: true });
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
    const record = new SupervisorEvidence(runDir);
    try {
      await waitForCondition(() => record.read().hold?.kind === 'custody-unreadable', 10_000);
      expect(record.read().hold).toEqual({
        kind: 'custody-unreadable',
        path: unreadablePath,
        observation: 'custody-record-unreadable',
        retry: 'restore-readable-custody-record',
      });
      expect(record.read().launch).toBeNull();
      rmSync(unreadablePath, { recursive: true });
      await waitForCondition(() => record.read().launch?.phase === 'serving', 15_000);
      expect(record.read().hold).toBeUndefined();
    } finally {
      const state = record.read();
      record.close();
      supervisor.kill('SIGKILL');
      if (state.launch?.child?.pid !== undefined) {
        try {
          process.kill(state.launch.child.pid, 'SIGKILL');
        } catch {
          // The fixture may already have exited.
        }
      }
      for (const root of roots.reverse()) rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
  it('starts recovery for an unresolved job with decisively absent CLI custody', async () => {
    const home = mkdtempSync(join(tmpdir(), 'coral-absent-cli-controller-'));
    const roots = [home];
    const plugin = createPluginFixture(roots, { flavor: 'prod', version: '0.10.14' });
    let supervisor: ReturnType<typeof spawn> | null = null;
    let record: SupervisorEvidence | null = null;
    try {
      const runtime = createRealRuntime('prod', { baseDir: join(home, '.coral') });
      const runDir = runtime.paths.coral.coordinator.runDir;
      const index = new JobLocationIndex(runtime, runtime.paths.coral.generation.dataRoot);
      index.register('absent-job', 'epoch-1', { projectRoot: home, workDir: home, jobKind: 'provider' });
      const intent = recordCustodyIntent(runtime, runDir, {
        effect: 'process-spawn',
        epoch: 'epoch-1',
        owner: 'durable-cli',
        operationId: 'absent-job',
        capsule: null,
        bindWithinMs: 1_000,
        nowMs: 100,
      });
      reconcileCustodyLedger(runtime, runDir, 2_000, 100, () => ({
        kind: 'absent',
        processToken: intent.processToken,
        evidence: 'wrapper never started',
      }));
      expect(controllerBuild(runDir)).toEqual({ kind: 'none' });
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
      supervisor = spawn(process.execPath, [harness, join(plugin.root, 'bridge', 'coral-backend.cjs')], {
        env: { ...process.env, HOME: home, TMPDIR: home, CORAL_SENTINEL_RUN_DIR: runDir },
        stdio: 'ignore',
      });
      record = new SupervisorEvidence(runDir);
      await waitForCondition(() => record?.read().launch?.phase === 'serving', 15_000);
      expect(index.locations().find((location) => location.jobId === 'absent-job')?.disposition).not.toBe('terminal');
    } finally {
      const childPid = record?.read().launch?.child?.pid;
      record?.close();
      supervisor?.kill('SIGKILL');
      if (childPid !== undefined) {
        try {
          process.kill(childPid, 'SIGKILL');
        } catch {
          // The fixture may already have exited.
        }
      }
      for (const root of roots.reverse()) rmSync(root, { recursive: true, force: true });
    }
  }, 25_000);
  it('reports acceptance only after the requested build publishes supervised discovery', async () => {
    const roots: string[] = [];
    const home = mkdtempSync(join(tmpdir(), 'coral-supervisor-acceptance-'));
    roots.push(home);
    const target = createPluginFixture(roots, { flavor: 'prod', version: '0.10.16' });
    const paths = coordinatorPaths('prod', { baseDir: join(home, '.coral') });
    const record = new SupervisorEvidence(paths.runDir);
    try {
      const manifest = validatedBuild(target.root);
      const incarnation = probeProcessIncarnation(process.pid);
      if (manifest === null || incarnation === null) throw new Error('Fixture identity is unavailable');
      const desired = {
        version: manifest.version,
        bundleHash: manifest.bundleHash,
        flavor: manifest.flavor,
        namespace: 'test',
      };
      await record.request(join(target.root, 'bridge', 'coral-backend.cjs'), manifest.buildSetId);
      expect(supervisorAcceptedUpgrade(paths, desired, Date.now())).toBe('unproven');
      mkdirSync(paths.runDir, { recursive: true });
      expect(supervisorAcceptedUpgrade(paths, desired, Date.now())).toBe('unproven');
      writeFileSync(
        paths.infoFile,
        JSON.stringify({
          pid: process.pid,
          port: 1,
          socketPath: 'test-socket',
          bundleHash: manifest.bundleHash,
          flavor: manifest.flavor,
          namespace: 'test',
          startedAt: Date.now(),
          token: 'token',
          bootToken: 'boot',
          host: '127.0.0.1',
          version: manifest.version,
          instanceId: randomUUID(),
          incarnation,
          supervision: {
            version: 1,
            launchId: randomUUID(),
            admittedAt: Date.now(),
            buildSetId: manifest.buildSetId,
            purpose: 'legacy-retirement',
            parent: { pid: process.pid, incarnation },
          },
        }),
      );
      expect(supervisorAcceptedUpgrade(paths, desired, Date.now())).toBe('accepted');
      rmSync(paths.infoFile);
      expect(supervisorAcceptedUpgrade(paths, desired, Date.now())).toBe('unproven');
    } finally {
      record.close();
      for (const root of roots.reverse()) rmSync(root, { recursive: true, force: true });
    }
  });
  it('does not let a v1 capsule, which no build can take over, hold every launch', () => {
    const home = mkdtempSync(join(tmpdir(), 'coral-v1-controller-'));
    try {
      const baseDir = join(home, '.coral');
      const capsule = handoffCapsuleV1Schema.parse({
        version: 1,
        grantId: '11111111-1111-4111-8111-111111111111',
        secret: 'a'.repeat(64),
        generation: 'gen2',
        flavor: 'prod',
        buildSetId: '22222222-2222-4222-8222-222222222222',
        hostFingerprint: 'b'.repeat(64),
        guardianInstanceId: '33333333-3333-4333-8333-333333333333',
        reaperInstanceId: '44444444-4444-4444-8444-444444444444',
        proxyInstanceId: '55555555-5555-4555-8555-555555555555',
        guardianControlEndpoint: join(home, 'guardian.sock'),
        reaperControlEndpoint: join(home, 'reaper.sock'),
        proxyEndpoint: join(home, 'proxy.sock'),
        orphanTimeoutMs: 60_000,
        teardownReserveMs: 10_000,
      });
      const path = providerHandoffCapsulePath(capsule, capsule.version, { baseDir });
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(capsule), { mode: 0o600 });

      expect(controllerBuild(coordinatorPaths('prod', { baseDir }).runDir)).toEqual({ kind: 'none' });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('settles an equal-version different-build request as redundant', async () => {
    const roots: string[] = [];
    const home = mkdtempSync(join(tmpdir(), 'coral-equal-version-request-'));
    roots.push(home);
    const incumbent = createPluginFixture(roots, { flavor: 'prod', version: '0.10.14' });
    const rebuilt = createPluginFixture(roots, { flavor: 'prod', version: '0.10.14', bundleHash: 'rebuilt' });
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
      env: { ...process.env, HOME: home, TMPDIR: home, CORAL_SENTINEL_RUN_DIR: runDir },
      stdio: 'ignore',
    });
    const record = new SupervisorEvidence(runDir);
    try {
      await waitForCondition(() => record.read().launch?.phase === 'serving', 20_000);
      const request = await record.request(
        join(rebuilt.root, 'bridge', 'coral-backend.cjs'),
        fixtureBuildSetId(rebuilt.root),
      );
      await waitForCondition(
        () => record.read().requests.find((entry) => entry.id === request.id)?.status !== 'recorded',
        5_000,
      );
      expect(record.read().requests.find((entry) => entry.id === request.id)?.status).toBe('unavailable');
      expect(record.read().attempt).toBeNull();
    } finally {
      const childPid = record.read().launch?.child?.pid;
      record.close();
      if (supervisor.exitCode === null) supervisor.kill('SIGTERM');
      if (childPid !== undefined) {
        try {
          process.kill(childPid, 'SIGKILL');
        } catch {
          // The child may already have exited.
        }
      }
      for (const root of roots.reverse()) rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('keeps a healthy v0.10.13 child serving after its heartbeat lapse', async () => {
    const roots: string[] = [];
    const home = mkdtempSync(join(tmpdir(), 'coral-shipped-watchdog-'));
    roots.push(home);
    const shipped = createShippedPluginFixture(roots, 'v0.10.13');
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
    const supervisor = spawn(process.execPath, [harness, join(shipped.root, 'bridge', 'coral-backend.cjs')], {
      env: { ...process.env, HOME: home, TMPDIR: home, CORAL_SENTINEL_RUN_DIR: runDir },
      stdio: 'ignore',
    });
    const record = new SupervisorEvidence(runDir);
    let childPid: number | undefined;
    try {
      await waitForCondition(() => record.read().launch?.phase === 'serving', 20_000);
      childPid = record.read().launch?.child?.pid;
      if (childPid === undefined) throw new Error('Serving child has no PID');
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(record.read().launch).toMatchObject({ phase: 'serving', child: { pid: childPid } });
      expect(() => process.kill(childPid!, 0)).not.toThrow();
    } finally {
      record.close();
      if (supervisor.exitCode === null) supervisor.kill('SIGTERM');
      if (childPid !== undefined) {
        try {
          process.kill(childPid, 'SIGKILL');
        } catch {
          // The child may already have exited.
        }
      }
      for (const root of roots.reverse()) rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('admits a shipped backend using the current supervisor', async () => {
    const roots: string[] = [];
    const home = mkdtempSync(join(tmpdir(), 'coral-shipped-supervisor-'));
    roots.push(home);
    const shipped = createShippedPluginFixture(roots, 'v0.10.13');
    expect(validatedBuild(shipped.root)).not.toBeNull();
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
    const supervisor = spawn(process.execPath, [harness, join(shipped.root, 'bridge', 'coral-backend.cjs')], {
      env: { ...process.env, HOME: home, TMPDIR: home, CORAL_SENTINEL_RUN_DIR: runDir },
      stdio: 'ignore',
    });
    const record = new SupervisorEvidence(runDir);
    try {
      await waitForCondition(() => record.read().launch?.phase === 'serving', 20_000);
      expect(record.read().launch?.buildSetId).toBe(fixtureBuildSetId(shipped.root));
      expect(record.read().attempt).toBeNull();
      const discovery = JSON.parse(readFileSync(join(runDir, 'coordinator.json'), 'utf8')) as { pid: number };
      expect(discovery.pid).toBe(record.read().launch?.child?.pid);
    } finally {
      const childPid = record.read().launch?.child?.pid;
      record.close();
      if (supervisor.exitCode === null) supervisor.kill('SIGTERM');
      if (childPid !== undefined) {
        try {
          process.kill(childPid, 'SIGKILL');
        } catch {
          // The child may already have exited.
        }
      }
      for (const root of roots.reverse()) rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('rejects rollback and accepts a newer request while its child is starting', async () => {
    const roots: string[] = [];
    const home = mkdtempSync(join(tmpdir(), 'coral-starting-requests-'));
    roots.push(home);
    const older = createPluginFixture(roots, { flavor: 'prod', version: '0.10.13' });
    const current = createPluginFixture(roots, { flavor: 'prod', version: '0.10.14', backend: 'sentinel-freeze' });
    const equal = createPluginFixture(roots, { flavor: 'prod', version: '0.10.14', bundleHash: 'rebuilt' });
    const newer = createPluginFixture(roots, { flavor: 'prod', version: '0.10.16' });
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
    const supervisor = spawn(process.execPath, [harness, join(current.root, 'bridge', 'coral-backend.cjs')], {
      env: {
        ...process.env,
        HOME: home,
        TMPDIR: home,
        CORAL_SENTINEL_RUN_DIR: runDir,
        CORAL_FIXTURE_FAIL_INSTALLED_ROOTS: current.root,
        CORAL_FIXTURE_FAIL_AFTER_MS: '10000',
      },
      stdio: 'ignore',
    });
    const record = new SupervisorEvidence(runDir);
    let cli: ReturnType<typeof spawn> | null = null;
    try {
      await waitForCondition(() => record.read().launch?.phase === 'admitted', 10_000);
      const rollback = await record.request(
        join(older.root, 'bridge', 'coral-backend.cjs'),
        fixtureBuildSetId(older.root),
      );
      const redundant = await record.request(
        join(equal.root, 'bridge', 'coral-backend.cjs'),
        fixtureBuildSetId(equal.root),
      );
      const runningCli = spawn(process.execPath, [join(newer.root, 'bridge', 'coral-cli'), 'backend', 'start'], {
        cwd: home,
        env: {
          ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('CORAL_'))),
          HOME: home,
          TMPDIR: home,
          CLAUDE_PLUGIN_ROOT: newer.root,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      cli = runningCli;
      let cliOutput = '';
      runningCli.stdout?.on('data', (chunk: Buffer) => (cliOutput += chunk.toString()));
      runningCli.stderr?.on('data', (chunk: Buffer) => (cliOutput += chunk.toString()));
      try {
        await waitForCondition(() => {
          const requests = record.read().requests;
          return (
            requests.find((entry) => entry.id === rollback.id)?.status === 'unavailable' &&
            requests.find((entry) => entry.id === redundant.id)?.status === 'unavailable' &&
            requests.find((entry) => entry.buildSetId === fixtureBuildSetId(newer.root))?.status === 'accepted'
          );
        }, 5_000);
      } catch (error: unknown) {
        throw new Error(`Starting request was not accepted: ${JSON.stringify({ state: record.read(), cliOutput })}`, {
          cause: error,
        });
      }
      expect(record.read().launch?.buildSetId).toBe(fixtureBuildSetId(current.root));
      await waitForCondition(() => runningCli.exitCode !== null, 20_000);
      expect(runningCli.exitCode, `${cliOutput}; ${JSON.stringify(record.read())}`).toBe(0);
    } finally {
      const childPid = record.read().launch?.child?.pid;
      record.close();
      if (cli !== null && cli.exitCode === null) cli.kill('SIGKILL');
      if (supervisor.exitCode === null) supervisor.kill('SIGTERM');
      if (childPid !== undefined) {
        try {
          process.kill(childPid, 'SIGKILL');
        } catch {
          // The child may already have exited.
        }
      }
      for (const root of roots.reverse()) rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);

  it('marks a persisted request unavailable after its target disappears', async () => {
    const roots: string[] = [];
    const home = mkdtempSync(join(tmpdir(), 'coral-supervisor-missing-target-'));
    roots.push(home);
    const original = createPluginFixture(roots, { flavor: 'prod', version: '0.10.13' });
    const missing = createPluginFixture(roots, { flavor: 'prod', version: '0.10.16' });
    const baseDir = join(home, '.coral');
    const runDir = coordinatorPaths('prod', { baseDir }).runDir;
    const initialRecord = new SupervisorEvidence(runDir);
    const missingRequest = await initialRecord.request(
      join(missing.root, 'bridge', 'coral-backend.cjs'),
      fixtureBuildSetId(missing.root),
    );
    initialRecord.close();
    rmSync(missing.root, { recursive: true, force: true });
    const registry = join(home, 'installed.json');
    writeFileSync(registry, JSON.stringify({ plugins: { 'coral@fixture': [{ installPath: original.root }] } }));
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
        CORAL_PLUGIN_REGISTRY: registry,
      },
      stdio: 'ignore',
    });
    const record = new SupervisorEvidence(runDir);
    try {
      await waitForCondition(() => record.read().launch?.phase === 'serving', 20_000);
      await new Promise((resolve) => setTimeout(resolve, 750));
      expect(record.read().requests.find((request) => request.id === missingRequest.id)?.status).toBe('unavailable');
      const childPid = record.read().launch?.child?.pid;
      if (childPid === undefined) throw new Error('Serving child has no PID');
      process.kill(childPid, 'SIGINT');
      await waitForCondition(() => supervisor.exitCode !== null, 15_000);
      expect(supervisor.exitCode).toBe(0);
    } finally {
      const childPid = record.read().launch?.child?.pid;
      record.close();
      if (supervisor.exitCode === null) supervisor.kill('SIGTERM');
      if (childPid !== undefined) {
        try {
          process.kill(childPid, 'SIGKILL');
        } catch {
          // The child may already have exited.
        }
      }
      for (const root of roots.reverse()) rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
