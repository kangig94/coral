import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

import { coordinatorPaths } from '#src/infra/path/coordinator.js';
import { createIpcClient } from '#src/transport/ipc/client.js';
import { createPluginFixture } from '#tests/integration/coordinator/helpers.js';
import { waitForCondition } from '#tests/support/wait-for-condition.js';

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('real coordinator recovery through its sentinel', () => {
  it('shuts down a coordinator when its parent sentinel dies', async () => {
    const roots: string[] = [];
    const home = mkdtempSync(join(tmpdir(), 'coral-sentinel-parent-death-'));
    roots.push(home);
    const fixture = createPluginFixture(roots, { flavor: 'prod' });
    const paths = coordinatorPaths('prod', { baseDir: join(home, '.coral') });
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, TMPDIR: home, CORAL_SENTINEL_RUN_DIR: paths.runDir };
    delete env.CORAL_CHILD;
    delete env.CORAL_CHILD_PRINCIPAL_HANDLE;
    delete env.CORAL_JOB_ID;
    delete env.CORAL_SESSION_ID;
    const sentinel = spawn(
      process.execPath,
      [join(fixture.root, 'bridge', 'coral-sentinel.cjs'), join(fixture.root, 'bridge', 'coral-backend.cjs')],
      { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
    );
    let childPid: number | null = null;
    sentinel.on('message', (message: unknown) => {
      if (
        typeof message === 'object' &&
        message !== null &&
        'kind' in message &&
        message.kind === 'coral-sentinel-child' &&
        'pid' in message &&
        typeof message.pid === 'number'
      ) {
        childPid = message.pid;
      }
    });
    try {
      await waitForCondition(() => existsSync(paths.infoFile), 15_000);
      expect(childPid).not.toBeNull();
      const discovery = JSON.parse(readFileSync(paths.infoFile, 'utf8')) as {
        bootToken: string;
        sentinel: { version: number; id: string };
      };
      const ipc = createIpcClient(paths.socketPath, undefined, { kind: 'boot', token: discovery.bootToken });
      const ping = await ipc.ping<{ sentinel?: unknown }>();
      const health = await ipc.health<{ sentinel?: unknown }>();
      expect(ping.sentinel).toEqual(discovery.sentinel);
      expect(health.sentinel).toEqual(discovery.sentinel);
      const records = readdirSync(join(paths.runDir, 'coordinator-sentinel.v1'));
      expect(records).toHaveLength(1);
      const recordPath = join(paths.runDir, 'coordinator-sentinel.v1', records[0] ?? 'missing');
      expect(JSON.parse(readFileSync(recordPath, 'utf8'))).toMatchObject({
        state: 'armed',
        coordinatorPid: childPid,
      });
      sentinel.kill('SIGKILL');
      await new Promise<void>((resolve) => sentinel.once('exit', () => resolve()));
      await waitForCondition(() => childPid !== null && !alive(childPid), 35_000);
    } finally {
      if (sentinel.exitCode === null) sentinel.kill('SIGKILL');
      if (childPid !== null && alive(childPid)) process.kill(childPid, 'SIGKILL');
      for (const path of roots.reverse()) rmSync(path, { recursive: true, force: true });
    }
  }, 45_000);

  it('ends a blocked coordinator and lets a waiting CLI reach its replacement', async () => {
    const tempRoots: string[] = [];
    const home = mkdtempSync(join(tmpdir(), 'coral-sentinel-recovery-home-'));
    tempRoots.push(home);
    const fixture = createPluginFixture(tempRoots, { flavor: 'prod', backend: 'sentinel-freeze' });
    const sentinelPath = join(fixture.root, 'bridge', 'coral-sentinel.cjs');
    await build({
      entryPoints: [fileURLToPath(new URL('./fixtures/sentinel-harness.ts', import.meta.url))],
      outfile: sentinelPath,
      bundle: true,
      platform: 'node',
      target: 'node22',
      format: 'cjs',
      external: ['node:*'],
    });
    const backend = join(fixture.root, 'bridge', 'coral-backend.cjs');
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, TMPDIR: home };
    delete env.CORAL_CHILD;
    delete env.CORAL_CHILD_PRINCIPAL_HANDLE;
    delete env.CORAL_JOB_ID;
    delete env.CORAL_SESSION_ID;
    const first = spawn(process.execPath, [sentinelPath, backend], {
      env,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let firstOutput = '';
    first.stdout?.on('data', (part: Buffer) => {
      firstOutput += part.toString();
    });
    first.stderr?.on('data', (part: Buffer) => {
      firstOutput += part.toString();
    });
    let firstPid: number | null = null;
    first.on('message', (message: unknown) => {
      if (
        typeof message === 'object' &&
        message !== null &&
        'kind' in message &&
        message.kind === 'coral-sentinel-child' &&
        'pid' in message &&
        typeof message.pid === 'number'
      ) {
        firstPid = message.pid;
      }
    });
    let cli: ReturnType<typeof spawn> | null = null;
    try {
      const discovery = coordinatorPaths('prod', { baseDir: join(home, '.coral') });
      await waitForCondition(() => existsSync(discovery.infoFile), 20_000).catch((error: unknown) => {
        throw new Error(`${String(error)}; sentinel exit=${first.exitCode}; output=${firstOutput}`);
      });
      expect(firstPid).not.toBeNull();
      const original = JSON.parse(readFileSync(discovery.infoFile, 'utf8')) as { pid: number; sentinel?: unknown };
      expect(original.pid).toBe(firstPid);
      expect(original.sentinel).toBeDefined();

      first.send({ kind: 'freeze-coordinator' });
      cli = spawn(process.execPath, [join(fixture.root, 'bridge', 'coral-cli'), 'backend', 'start'], {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      cli.stdout?.on('data', (part: Buffer) => {
        output += part.toString();
      });
      cli.stderr?.on('data', (part: Buffer) => {
        output += part.toString();
      });
      await new Promise<void>((resolve) => first.once('exit', () => resolve()));
      expect(alive(original.pid)).toBe(false);
      await waitForCondition(() => {
        if (!existsSync(discovery.infoFile)) return false;
        const current = JSON.parse(readFileSync(discovery.infoFile, 'utf8')) as { pid: number };
        return current.pid !== original.pid && alive(current.pid);
      }, 20_000).catch((error: unknown) => {
        throw new Error(
          `${String(error)}; CLI exit=${cli?.exitCode}; CLI output=${output}; sentinel output=${firstOutput}`,
        );
      });
      const cliExit = await new Promise<number | null>((resolve) => cli?.once('exit', (code) => resolve(code)));
      expect(cliExit, output).toBe(0);
      const replacement = JSON.parse(readFileSync(discovery.infoFile, 'utf8')) as { pid: number };
      expect(replacement.pid).not.toBe(original.pid);
      process.kill(replacement.pid, 'SIGTERM');
      await waitForCondition(() => !alive(replacement.pid), 10_000);
    } finally {
      if (cli !== null && cli.exitCode === null) cli.kill('SIGKILL');
      if (first.exitCode === null) first.kill('SIGKILL');
      if (firstPid !== null && alive(firstPid)) process.kill(firstPid, 'SIGKILL');
      for (const path of tempRoots.reverse()) rmSync(path, { recursive: true, force: true });
    }
  }, 60_000);
});
