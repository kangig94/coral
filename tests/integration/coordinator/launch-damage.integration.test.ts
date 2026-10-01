import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';
import { expect, it } from 'vitest';
import { repairMalformedFileLockSync } from '#src/infra/fs-lock.js';
import { coordinatorPaths } from '#src/infra/path/coordinator.js';
import { createPluginFixture, waitForDiscoveryRecord } from './helpers.js';
import { stopRecordedProcesses } from '#tests/support/stop-recorded-processes.js';
import { requestIpcMethod } from '#src/transport/ipc/client.js';

type Damage = 'truncated' | 'write-version' | 'read-version' | 'junk';

function damageLock(path: string, damage: Damage): void {
  const bytes = readFileSync(path);
  if (damage === 'truncated') writeFileSync(path, bytes.subarray(0, 100));
  else if (damage === 'junk') writeFileSync(path, 'garbage');
  else {
    bytes[damage === 'write-version' ? 18 : 19] = 255;
    writeFileSync(path, bytes);
  }
}

it.each(['truncated', 'write-version', 'read-version', 'junk'] as const)(
  'automatically boots and serves through %s namespace lock damage',
  async (damage) => {
    const roots: string[] = [];
    const home = mkdtempSync(join(tmpdir(), 'coral-damaged-launch-lock-'));
    roots.push(home);
    const fixture = createPluginFixture(roots, { flavor: 'prod' });
    const runDir = coordinatorPaths('prod', { baseDir: join(home, '.coral') }).runDir;
    mkdirSync(runDir, { recursive: true });
    const path = join(runDir, 'namespace-supervisor.v1.lock');
    const db = new DatabaseSync(path);
    db.exec('CREATE TABLE dummy(x)');
    db.close();
    const inode = statSync(path).ino;
    damageLock(path, damage);
    const harness = join(home, 'supervisor.mjs');
    await build({
      entryPoints: [fileURLToPath(new URL('./fixtures/namespace-supervisor-harness.ts', import.meta.url))],
      outfile: harness,
      bundle: true,
      platform: 'node',
      format: 'esm',
      external: ['node:*'],
    });
    const supervisor = spawn(process.execPath, [harness, join(fixture.root, 'bridge', 'coral-backend.cjs')], {
      env: {
        ...process.env,
        HOME: home,
        TMPDIR: home,
        CORAL_SENTINEL_RUN_DIR: runDir,
        CORAL_FIXTURE_REAL_BACKEND: '1',
      },
      stdio: 'ignore',
    });
    let child: { pid: number; incarnation?: string } | undefined;
    try {
      const discovery = await waitForDiscoveryRecord(home, 'prod', 8_000);
      child = discovery;
      expect(statSync(path).ino).not.toBe(inode);
      expect(readdirSync(runDir).some((name) => name.startsWith('namespace-supervisor.v1.lock.malformed-'))).toBe(true);
      await expect(
        requestIpcMethod(discovery.socketPath, 'transport.health', undefined, {
          auth: { kind: 'boot', token: discovery.bootToken },
          timeoutMs: 1_000,
        }),
      ).resolves.toMatchObject({ status: 'ok' });
    } finally {
      const exited = once(supervisor, 'exit');
      supervisor.kill('SIGKILL');
      await exited;
      if (child !== undefined)
        await stopRecordedProcesses([{ pid: child.pid, incarnation: child.incarnation ?? null }]);
      for (const root of roots.reverse()) rmSync(root, { recursive: true, force: true });
    }
  },
);

it.each(
  (['truncated', 'write-version', 'read-version', 'junk'] as const).flatMap((damage) =>
    (['shared', 'exclusive'] as const).map((mode) => [damage, mode] as const),
  ),
)('never moves a %s inode with an existing %s holder', async (damage, mode) => {
  const root = mkdtempSync(join(tmpdir(), 'coral-held-damaged-lock-'));
  const path = join(root, 'lock');
  let holder: ChildProcess | undefined;
  try {
    holder = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { DatabaseSync } from 'node:sqlite'; const db = new DatabaseSync(process.argv[1]); db.exec('CREATE TABLE dummy(x); ' + (process.argv[2] === 'exclusive' ? 'BEGIN EXCLUSIVE' : 'BEGIN; SELECT count(*) FROM sqlite_schema')); process.send('held'); setInterval(() => {}, 1000);`,
        path,
        mode,
      ],
      { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
    );
    await once(holder, 'message');
    const inode = statSync(path).ino;
    damageLock(path, damage);
    expect(repairMalformedFileLockSync(path).kind).toBe('held');
    expect(statSync(path).ino).toBe(inode);
    const exited = once(holder, 'exit');
    holder.kill('SIGKILL');
    await exited;
    expect(repairMalformedFileLockSync(path).kind).toBe('moved-aside');
    expect(existsSync(path)).toBe(false);
  } finally {
    if (holder !== undefined && holder.exitCode === null && holder.signalCode === null) {
      const exited = once(holder, 'exit');
      holder.kill('SIGKILL');
      await exited;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

it('quarantines corrupt upgrade intent under namespace ownership before the first launch', async () => {
  const roots: string[] = [];
  const home = mkdtempSync(join(tmpdir(), 'coral-corrupt-intent-boot-'));
  roots.push(home);
  const fixture = createPluginFixture(roots, { flavor: 'prod' });
  const runDir = coordinatorPaths('prod', { baseDir: join(home, '.coral') }).runDir;
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'upgrade.v1.json'), '{');
  const harness = join(home, 'supervisor.mjs');
  await build({
    entryPoints: [fileURLToPath(new URL('./fixtures/namespace-supervisor-harness.ts', import.meta.url))],
    outfile: harness,
    bundle: true,
    platform: 'node',
    format: 'esm',
    external: ['node:*'],
  });
  const supervisor = spawn(process.execPath, [harness, join(fixture.root, 'bridge', 'coral-backend.cjs')], {
    env: { ...process.env, HOME: home, TMPDIR: home, CORAL_SENTINEL_RUN_DIR: runDir, CORAL_FIXTURE_REAL_BACKEND: '1' },
    stdio: 'ignore',
  });
  let child: { pid: number; incarnation?: string } | undefined;
  try {
    child = await waitForDiscoveryRecord(home, 'prod', 8_000);
    expect(existsSync(join(runDir, 'upgrade.v1.json'))).toBe(false);
    expect(readdirSync(runDir).some((name) => name.startsWith('upgrade.v1.corrupt-'))).toBe(true);
  } finally {
    const exited = once(supervisor, 'exit');
    supervisor.kill('SIGKILL');
    await exited;
    if (child !== undefined) await stopRecordedProcesses([{ pid: child.pid, incarnation: child.incarnation ?? null }]);
    for (const root of roots.reverse()) rmSync(root, { recursive: true, force: true });
  }
});

it('never moves a damaged inode held by a shared connection in the repair caller', () => {
  const root = mkdtempSync(join(tmpdir(), 'coral-local-held-corruption-'));
  const path = join(root, 'lock');
  const db = new DatabaseSync(path);
  try {
    db.exec('CREATE TABLE dummy(x); BEGIN; SELECT count(*) FROM sqlite_schema');
    const inode = statSync(path).ino;
    // A different process damages the file without closing a descriptor in the holder process.
    execFileSync(process.execPath, [
      '-e',
      "const fs = require('node:fs'); const path = process.argv[1]; fs.writeFileSync(path, fs.readFileSync(path).subarray(0, 100));",
      path,
    ]);
    expect(repairMalformedFileLockSync(path).kind).toBe('held');
    expect(statSync(path).ino).toBe(inode);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
