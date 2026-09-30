import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { expect, it } from 'vitest';

import { coordinatorPaths } from '#src/infra/path/coordinator.js';
import { probeProcessIncarnation } from '#src/infra/node-process.js';
import { readLaunchStatus } from '#src/infra/launch-status.js';
import { listLaunchAdmissions } from '#src/infra/launch-admission-record.js';
import { requestIpcMethod } from '#src/transport/ipc/client.js';
import type { HealthSnapshot } from '#src/transport/server-ports.js';
import { createPluginFixture, waitForDiscoveryRecord } from '#tests/integration/coordinator/helpers.js';
import { waitForCondition } from '#tests/support/wait-for-condition.js';

it.each(['owner', 'claim'])(
  'keeps serving through multiple %s status markers and republishes current holds after recovery',
  async (marker) => {
    const roots: string[] = [];
    const home = mkdtempSync(join(tmpdir(), 'coral-status-publication-'));
    const otherHome = mkdtempSync(join(tmpdir(), 'coral-status-independent-'));
    roots.push(home, otherHome);
    const fixture = createPluginFixture(roots, { flavor: 'prod', version: '0.10.14' });
    const runDir = coordinatorPaths('prod', { baseDir: join(home, '.coral') }).runDir;
    const lockDir = join(runDir, 'launch-status.v1.lock');
    mkdirSync(lockDir, { recursive: true });
    for (const id of ['one', 'two']) writeFileSync(join(lockDir, `${marker}-${id}.lock`), '{}');
    mkdirSync(join(runDir, 'launch-admissions.v1'));
    const oldAdmission = join(runDir, 'launch-admissions.v1', '00000000-0000-4000-8000-000000000001.json');
    writeFileSync(oldAdmission, '{');
    const oldDatabase = join(runDir, 'coordinator-launch.v1.sqlite');
    writeFileSync(oldDatabase, 'leftover branch database');
    const harness = join(home, 'supervisor.mjs');
    await build({
      entryPoints: [fileURLToPath(new URL('./fixtures/namespace-supervisor-harness.ts', import.meta.url))],
      outfile: harness,
      bundle: true,
      platform: 'node',
      format: 'esm',
      external: ['node:*'],
    });
    const supervisors: ChildProcess[] = [];
    const children: { pid: number; incarnation?: string }[] = [];
    const start = (root: string) => {
      const child = spawn(process.execPath, [harness, join(fixture.root, 'bridge', 'coral-backend.cjs')], {
        cwd: root,
        env: {
          ...process.env,
          HOME: root,
          TMPDIR: root,
          CORAL_FIXTURE_REAL_BACKEND: '1',
          CORAL_SENTINEL_RUN_DIR: coordinatorPaths('prod', { baseDir: join(root, '.coral') }).runDir,
        },
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      });
      supervisors.push(child);
      return child;
    };
    try {
      const supervisor = start(home);
      const serving = await waitForDiscoveryRecord(home, 'prod', 15_000);
      children.push(serving);
      supervisor.send('fixture-status-hold');
      const other = start(otherHome);
      const independent = await waitForDiscoveryRecord(otherHome, 'prod', 15_000);
      children.push(independent);
      const health = () =>
        requestIpcMethod<HealthSnapshot>(serving.socketPath, 'transport.health', undefined, {
          auth: { kind: 'boot', token: serving.bootToken },
          timeoutMs: 1_000,
        });
      let current = await health();
      for (let retry = 0; retry < 30 && current.launchStatus?.hold?.kind !== 'custody-unreadable'; retry += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        current = await health();
      }
      expect(current.status).toBe('ok');
      expect(current.launchStatus).toMatchObject({
        hold: { kind: 'custody-unreadable', path: '/fixture/custody' },
        publicationFailure: { code: 'status-publication-unavailable' },
      });
      expect(supervisor.exitCode).toBeNull();
      expect(other.exitCode).toBeNull();
      expect(readdirSync(lockDir).sort()).toEqual([`${marker}-one.lock`, `${marker}-two.lock`]);
      await expect(
        requestIpcMethod(independent.socketPath, 'transport.health', undefined, {
          auth: { kind: 'boot', token: independent.bootToken },
          timeoutMs: 1_000,
        }),
      ).resolves.toMatchObject({ status: 'ok' });
      const admissions = listLaunchAdmissions(runDir);
      expect(admissions).toHaveLength(1);
      expect(admissions[0]).toMatchObject({
        kind: 'readable',
        admission: { admittedAt: serving.supervision?.admittedAt },
      });
      expect(readFileSync(oldAdmission, 'utf8')).toBe('{');
      expect(readFileSync(oldDatabase, 'utf8')).toBe('leftover branch database');
      rmSync(lockDir, { recursive: true });
      await waitForCondition(() => {
        const status = readLaunchStatus(runDir);
        return status.kind === 'readable' && status.status.hold?.kind === 'custody-unreadable';
      }, 3_000);
      expect(readLaunchStatus(runDir)).toMatchObject({
        kind: 'readable',
        status: { hold: { path: '/fixture/custody' } },
      });
      await expect(health()).resolves.toMatchObject({ status: 'ok' });
      expect(readdirSync(runDir).some((name) => name.includes('fallback'))).toBe(false);
    } finally {
      for (const supervisor of supervisors) supervisor.kill('SIGKILL');
      for (const child of children) {
        if (probeProcessIncarnation(child.pid) === child.incarnation) process.kill(child.pid, 'SIGKILL');
      }
      await Promise.all(
        supervisors.map((supervisor) =>
          supervisor.exitCode !== null || supervisor.signalCode !== null
            ? Promise.resolve()
            : new Promise<void>((resolve) => supervisor.once('exit', () => resolve())),
        ),
      );
      for (const root of roots) rmSync(root, { recursive: true, force: true });
    }
  },
  35_000,
);
