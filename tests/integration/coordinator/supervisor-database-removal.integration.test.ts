import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

import { CURRENT_STRICT_BUNDLE_MANIFEST_FILE } from '#src/infra/bundle-manifest-address.js';
import { readLaunchAdmission } from '#src/infra/launch-admission-record.js';
import { readLaunchStatus, updateLaunchStatus } from '#src/infra/launch-status.js';
import { probeProcessIncarnation } from '#src/infra/node-process.js';
import { readUpgradeIntent } from '#src/infra/upgrade-intent.js';
import { coordinatorPaths } from '#src/infra/path/coordinator.js';
import { createPluginFixture } from '#tests/integration/coordinator/helpers.js';
import { SupervisorEvidence } from '#tests/support/supervisor-evidence.js';
import { waitForCondition } from '#tests/support/wait-for-condition.js';

function buildSetId(root: string): string {
  const manifest = JSON.parse(readFileSync(join(root, 'bridge', CURRENT_STRICT_BUNDLE_MANIFEST_FILE), 'utf8')) as {
    buildSetId: string;
  };
  return manifest.buildSetId;
}

describe.runIf(process.platform === 'linux')('supervisor database removal recovery', () => {
  it.each([
    'permanent parent freeze',
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
        fault === 'discovery overlap' || fault === 'serving successor upgrade'
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
          return;
        }
        await waitForCondition(
          () => {
            remember();
            const owner = evidence.read().owner;
            if (owner !== null) expect(owner.process.pid).toBe(evidence.lockHolder()?.pid);
            return (
              owner !== null &&
              (fault === 'serving successor upgrade'
                ? owner.process.pid === supervisor.pid
                : owner.process.pid !== supervisor.pid) &&
              evidence.lockHolder()?.pid === owner.process.pid
            );
          },
          fault === 'permanent parent freeze' ? 5_000 : 15_000,
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
        remember();
        supervisor.kill('SIGKILL');
        for (const [pid, incarnation] of identities) {
          if (probeProcessIncarnation(pid) !== incarnation) continue;
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            /* The exact fixture may have exited. */
          }
        }
        await new Promise<void>((resolve) =>
          supervisor.signalCode !== null || supervisor.exitCode !== null
            ? resolve()
            : supervisor.once('exit', () => resolve()),
        );
        for (const root of roots.reverse()) rmSync(root, { recursive: true, force: true });
      }
    },
    70_000,
  );
});
