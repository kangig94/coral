import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

import { childHasExited } from '#src/coordinator-launch/child-state.js';
import { createSharedFileLockSync } from '#src/infra/fs-lock.js';
import { launchAdmissionPath, listLaunchSubjects } from '#src/infra/launch-admission-record.js';
import { readLaunchStatus } from '#src/infra/launch-status.js';
import { observeProcessLiveness, type ProcessIncarnation } from '#src/infra/node-process.js';
import { supervisorLockPath } from '#src/infra/path/coordinator.js';
import { SupervisorEvidence } from '#tests/support/supervisor-evidence.js';
import { stopRecordedProcesses } from '#tests/support/stop-recorded-processes.js';
import { waitForCondition } from '#tests/support/wait-for-condition.js';
import { terminateChildProcess } from './helpers.js';

describe('namespace supervisor subject isolation', () => {
  it.skipIf(process.platform !== 'linux').each(['abandoned', 'held'] as const)(
    'retires an exact expired child despite an unrelated %s unreadable admission',
    async (other) => {
      const home = mkdtempSync(join(tmpdir(), 'coral-retirement-isolation-'));
      const bridge = join(home, 'plugin', 'bridge');
      const runDir = join(home, '.coral', 'gen2', 'run');
      mkdirSync(bridge, { recursive: true });
      const backend = join(bridge, 'coral-backend.cjs');
      const sentinel = join(bridge, 'coral-sentinel.cjs');
      for (const [fixture, outfile] of [
        ['expired-admission-child.ts', backend],
        ['namespace-supervisor-harness.ts', sentinel],
      ]) {
        await build({
          entryPoints: [fileURLToPath(new URL(`./fixtures/${fixture}`, import.meta.url))],
          outfile,
          bundle: true,
          platform: 'node',
          format: 'cjs',
          external: ['node:*'],
          banner: { js: 'var __fixtureUrl=require("url").pathToFileURL(__filename).href;' },
          define: { 'import.meta.url': '__fixtureUrl' },
        });
      }
      const hash = (name: string) =>
        createHash('sha256')
          .update(readFileSync(join(bridge, name)))
          .digest('hex')
          .slice(0, 16);
      for (const name of ['coral-cli', 'coral-claude-appserver.cjs', 'coral-durable-wrapper.cjs'])
        writeFileSync(join(bridge, name), '// fixture\n');
      writeFileSync(
        join(bridge, 'manifest.v2.json'),
        JSON.stringify({
          version: '0.10.15',
          buildSetId: randomUUID(),
          flavor: 'prod',
          bundleHash: hash('coral-backend.cjs'),
          cliBundleHash: hash('coral-cli'),
          claudeAppserverBundleHash: hash('coral-claude-appserver.cjs'),
          durableWrapperBundleHash: hash('coral-durable-wrapper.cjs'),
          storeFormatFingerprint: `sha256:${'a'.repeat(64)}`,
        }),
      );
      const marker = join(home, 'child-pid');
      const environment = {
        ...process.env,
        HOME: home,
        TMPDIR: home,
        CORAL_SENTINEL_RUN_DIR: runDir,
        CORAL_FIXTURE_CHILD_READY_PATH: marker,
        CORAL_FIXTURE_STARTUP_BUDGET_MS: '600',
      };
      const start = () => spawn(process.execPath, [sentinel, backend], { env: environment, stdio: 'ignore' });
      let supervisor: ChildProcess = start();
      let child: { pid: number; incarnation: ProcessIncarnation | null } | undefined;
      let releaseOther: (() => void) | undefined;
      try {
        await waitForCondition(
          () => listLaunchSubjects(runDir).some((subject) => subject.admission !== undefined) && existsSync(marker),
          5_000,
        );
        const admission = listLaunchSubjects(runDir).find((subject) => subject.admission !== undefined)?.admission;
        if (admission === undefined) throw new Error('Missing admission');
        child = admission.child;
        const namespace = statSync(supervisorLockPath(runDir));
        await terminateChildProcess(supervisor, 'SIGKILL');
        const otherId = randomUUID();
        const otherPath = launchAdmissionPath(runDir, otherId);
        writeFileSync(otherPath, '{');
        if (other === 'held')
          releaseOther = createSharedFileLockSync(
            join(runDir, 'launch-lifetimes.v1', otherId, 'unknown-envelope', 'lifetime.lock'),
          );
        supervisor = start();
        const evidence = new SupervisorEvidence(runDir);
        await waitForCondition(() => evidence.lockHolder()?.pid === supervisor.pid, 3_000);
        expect(statSync(supervisorLockPath(runDir)).ino).toBe(namespace.ino);
        expect(statSync(supervisorLockPath(runDir)).dev).toBe(namespace.dev);
        await waitForCondition(
          () => childHasExited(admission.child.pid) || observeProcessLiveness(admission.child.pid) === 'absent',
          3_500,
        );
        expect(Date.now() - admission.admittedAt).toBeLessThan(600 + 80 + 3_000);
        if (other === 'held') {
          expect(existsSync(otherPath)).toBe(true);
          expect(readLaunchStatus(runDir)).toMatchObject({
            kind: 'readable',
            status: { admissionHolds: expect.arrayContaining([{ path: otherPath, disposition: 'unknown' }]) },
          });
          expect(readFileSync(marker, 'utf8')).toBe(String(admission.child.pid));
          releaseOther?.();
          releaseOther = undefined;
          await waitForCondition(() => !existsSync(otherPath), 3_000);
        } else await waitForCondition(() => !existsSync(otherPath), 3_000);
      } finally {
        await terminateChildProcess(supervisor, 'SIGKILL');
        if (child !== undefined) await stopRecordedProcesses([child]);
        releaseOther?.();
        rmSync(home, { recursive: true, force: true });
      }
    },
  );
});
