import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { reapFixtureProcesses } from '../../../vitest/fixture-process-reaper.js';

const strays: number[] = [];
const roots: string[] = [];
afterEach(() => {
  for (const pid of strays.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      continue;
    }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function alive(pid: number): boolean {
  try {
    return !readFileSync(`/proc/${pid}/stat`, 'latin1').split(') ')[1]?.startsWith('Z');
  } catch {
    return false;
  }
}

/** An unscoped process must drop the scope inside the child; see install in vitest/coral-write-guard.cjs. */
function orphan(env: NodeJS.ProcessEnv, scoped: boolean): number {
  const sleep = scoped ? 'sleep 600' : 'env -u CORAL_TEST_PROCESS_SCOPE sleep 600';
  const result = spawnSync('sh', ['-c', `${sleep} >/dev/null 2>&1 & echo $!`], { env, encoding: 'utf8' });
  const pid = Number(result.stdout.trim());
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`orphan launch failed: ${result.stderr}`);
  strays.push(pid);
  return pid;
}

function home(): string {
  const root = mkdtempSync(join(tmpdir(), 'coral-reaper-home-'));
  roots.push(root);
  return root;
}

describe.runIf(process.platform === 'linux')('reapFixtureProcesses', () => {
  const scope = process.env.CORAL_TEST_PROCESS_SCOPE!;
  const boundary = { tempRoot: process.env.TMPDIR, sharedHomes: new Set([process.env.HOME!]) };

  it('reaps an orphan that inherited the file scope and leaves one with neither scope nor its HOME', async () => {
    const scopedHome = home();
    const scoped = orphan({ ...process.env, HOME: scopedHome }, true);
    const unrelated = orphan({ PATH: process.env.PATH, HOME: home() }, false);

    const reaped = await reapFixtureProcesses(scope, boundary);

    expect(reaped.map(({ pid }) => pid)).toContain(scoped);
    expect(alive(scoped)).toBe(false);
    expect(alive(unrelated)).toBe(true);
  });

  it('reaps a descendant launched with an explicit environment that omits the scope', async () => {
    const replaced = orphan({ PATH: process.env.PATH, HOME: home() }, true);

    await reapFixtureProcesses(scope, boundary);

    expect(alive(replaced)).toBe(false);
  });

  it('reaps an unscoped process that shares a scoped process HOME inside the temp root', async () => {
    const sharedHome = home();
    orphan({ ...process.env, HOME: sharedHome }, true);
    const sanitized = orphan({ PATH: process.env.PATH, HOME: sharedHome }, false);

    await reapFixtureProcesses(scope, boundary);

    expect(alive(sanitized)).toBe(false);
  });

  it.each([undefined, '', 'relative/tmp'])('trusts no HOME when the temp root is %j', async (tempRoot) => {
    const sharedHome = home();
    orphan({ ...process.env, HOME: sharedHome }, true);
    const sanitized = orphan({ PATH: process.env.PATH, HOME: sharedHome }, false);

    await reapFixtureProcesses(scope, { ...boundary, tempRoot });

    expect(alive(sanitized)).toBe(true);
  });

  it('leaves a scoped direct child of this worker to its owner', async () => {
    const child = spawn('sleep', ['600'], { stdio: 'ignore' });
    strays.push(child.pid!);

    await reapFixtureProcesses(scope, boundary);

    expect(alive(child.pid!)).toBe(true);
  });

  it('never extends the HOME match to the run-wide HOME every worker shares', async () => {
    orphan({ ...process.env }, true);
    const worker = orphan({ PATH: process.env.PATH, HOME: process.env.HOME }, false);

    await reapFixtureProcesses(scope, boundary);

    expect(alive(worker)).toBe(true);
  });

  it('never extends the HOME match to a HOME outside the temp root', async () => {
    const tempRoot = home();
    const outside = home();
    const scoped = orphan({ ...process.env, HOME: outside }, true);
    const sanitized = orphan({ PATH: process.env.PATH, HOME: outside }, false);

    await reapFixtureProcesses(scope, { ...boundary, tempRoot });

    expect(alive(scoped)).toBe(false);
    expect(alive(sanitized)).toBe(true);
  });
});
