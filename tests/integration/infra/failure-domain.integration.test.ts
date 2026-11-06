import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { build } from 'esbuild';
import { expect, it, vi } from 'vitest';

type FixtureEvent = {
  kind: string;
  root?: string;
  leaf?: string;
  pid?: number;
  provider?: number;
  cli?: number;
  jobId?: string;
  execution?: number;
  escaped?: number[];
  signal?: string;
  outcome?: string;
  observation?: string;
};

it.for(['local', 'proxy', 'wrapper-exit'])(
  '%s host close and containment reap escaped descendants while a sibling leaf survives',
  async (placement, context) => {
    if (process.platform !== 'linux') {
      console.warn('Skipping failure-domain integration: Linux cgroup v2 is required');
      context.skip('failure domains require Linux cgroup v2');
    }
    const bus = spawnSync('busctl', ['--user', 'status'], { encoding: 'utf8', timeout: 2_000 });
    if (bus.error !== undefined || bus.status !== 0) {
      const reason = `busctl --user status unavailable: ${bus.error?.message ?? bus.stderr.trim()}`;
      console.warn(`Skipping failure-domain integration: ${reason}`);
      context.skip(reason);
    }
    expect(spawnSync('python3', ['--version']).status, 'python3 is required by the fork/setsid fixture').toBe(0);
    const workDir = mkdtempSync(join(tmpdir(), 'coral-failure-domain-'));
    try {
      const unit = `app-coral-test-${randomUUID()}.scope`;
      const wrapper = join(workDir, 'coral-durable-wrapper.cjs');
      const fixture = join(workDir, 'scope.cjs');
      for (const [entry, outfile] of [
        ['src/runtime/durable-cli-wrapper.ts', wrapper],
        ['tests/fixtures/failure-domain/scope.ts', fixture],
      ]) {
        await build({
          entryPoints: [entry],
          outfile,
          bundle: true,
          platform: 'node',
          format: 'cjs',
          loader: { '.sql': 'text' },
          external: ['node:*', '@lydell/node-pty'],
          banner: { js: 'var __importMetaUrl=require("url").pathToFileURL(__filename).href;' },
          define: {
            'import.meta.url': '__importMetaUrl',
            __BUNDLE_DIR__: JSON.stringify(workDir),
            __PLUGIN_ROOT__: JSON.stringify(workDir),
          },
        });
      }
      const child = spawn(
        process.execPath,
        [fixture, unit, workDir, wrapper, resolve('tests/fixtures/failure-domain/forking-provider.py'), placement],
        {
          stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
          env: { ...process.env, CORAL_FAILURE_DOMAIN_ROOT: '', CORAL_FAILURE_DOMAIN: '' },
        },
      );
      const closed = once(child, 'exit');
      const events: FixtureEvent[] = [];
      let stderr = '';
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on('message', (event: FixtureEvent) => events.push(event));
      let ownRoot: string | undefined;
      try {
        await vi.waitFor(
          () => {
            ownRoot = events.find((event) => event.kind === 'root')?.root;
            expect(
              events.find((event) => event.kind === 'host'),
              stderr,
            ).toBeDefined();
            expect(
              events.find((event) => event.kind === 'sibling'),
              stderr,
            ).toBeDefined();
            expect(
              events.find((event) => event.kind === 'durable'),
              stderr,
            ).toBeDefined();
            expect(
              events.find((event) => event.kind === 'close-host'),
              stderr,
            ).toBeDefined();
            expect(
              events.find((event) => event.kind === 'attached'),
              stderr,
            ).toBeDefined();
          },
          { timeout: 15_000 },
        );
        expect(ownRoot).toMatch(new RegExp(`/${unit.replaceAll('.', '\\.')}$`));
        const attached = events.find((event) => event.kind === 'attached')!;
        expect(attached.root).toBe(ownRoot);
        expect(readFileSync(`/proc/${attached.pid}/cgroup`, 'utf8')).toContain(`/${unit}/supervisor-attach`);
        const durable = events.find((event) => event.kind === 'durable')!;
        expect(durable.execution).toBe(2);
        const jobLeaf = join(ownRoot!, `job-${durable.jobId}-${durable.execution}`);
        expect(durable.leaf).toBe(jobLeaf);
        for (const pid of [durable.pid, durable.cli]) {
          expect(readFileSync(`/proc/${pid}/cgroup`, 'utf8').trim()).toBe(
            `0::${jobLeaf.slice('/sys/fs/cgroup'.length)}`,
          );
        }
        expect(readFileSync(join(jobLeaf, 'memory.oom.group'), 'utf8').trim()).toBe('1');
        const host = events.find((event) => event.kind === 'host')!;
        const sibling = events.find((event) => event.kind === 'sibling')!;
        const hostLeaf = host.leaf!;
        const siblingLeaf = sibling.leaf!;
        expect(hostLeaf.startsWith(`${ownRoot}/`)).toBe(true);
        const processGroupAndSession = (pid: number): number[] => {
          const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
          return stat
            .slice(stat.lastIndexOf(')') + 2)
            .split(' ')
            .slice(2, 4)
            .map(Number);
        };
        const [setsidChild, ownGroupChild] = host.escaped!;
        expect(processGroupAndSession(setsidChild)).toEqual([setsidChild, setsidChild]);
        expect(processGroupAndSession(ownGroupChild)).toEqual([
          ownGroupChild,
          processGroupAndSession(host.provider!)[1],
        ]);
        const members = readFileSync(join(hostLeaf, 'cgroup.procs'), 'utf8').trim().split('\n').map(Number);
        expect(members).toEqual(expect.arrayContaining([host.pid, host.provider, ...host.escaped!]));
        expect(readFileSync(join(hostLeaf, 'memory.oom.group'), 'utf8').trim()).toBe('1');
        child.send('reap-host');
        await vi.waitFor(
          () =>
            expect(
              events.find((event) => event.kind === 'host-reaped'),
              stderr,
            ).toMatchObject({ outcome: 'containment-absent', observation: 'absent' }),
          { timeout: 5000 },
        );
        await vi.waitFor(
          () => expect(events.find((event) => event.kind === 'host-exit')).toMatchObject({ signal: 'SIGKILL' }),
          { timeout: 5_000 },
        );
        await vi.waitFor(
          () => {
            expect(readFileSync(join(hostLeaf, 'cgroup.events'), 'utf8')).toMatch(/^populated 0$/m);
            for (const pid of [host.provider!, ...host.escaped!]) {
              const stat = `/proc/${pid}/stat`;
              // An orphan zombie has no running payload and cannot retain cgroup population.
              expect(!existsSync(stat) || /\) Z /.test(readFileSync(stat, 'utf8'))).toBe(true);
            }
          },
          { timeout: 5_000 },
        );
        expect(() => process.kill(sibling.pid!, 0)).not.toThrow();
        expect(readFileSync(join(siblingLeaf, 'cgroup.events'), 'utf8')).toMatch(/^populated 1$/m);
        const closeHost = events.find((event) => event.kind === 'close-host')!;
        child.send('reuse-host-ticket');
        await vi.waitFor(
          () =>
            expect(
              events.find((event) => event.kind === 'ticket-reuse-refused'),
              stderr,
            ).toBeDefined(),
          { timeout: 5000 },
        );
        expect(() => process.kill(closeHost.pid!, 0)).not.toThrow();
        expect(readFileSync(join(closeHost.leaf!, 'cgroup.events'), 'utf8')).toMatch(/^populated 1$/m);
        child.send('close-host');
        await vi.waitFor(
          () =>
            expect(
              events.find((event) => event.kind === 'host-closed'),
              stderr,
            ).toMatchObject({ outcome: placement === 'wrapper-exit' ? 'cessation-proven' : 'observed-absent' }),
          { timeout: 12000 },
        );
        expect(readFileSync(join(closeHost.leaf!, 'cgroup.events'), 'utf8')).toMatch(/^populated 0$/m);
        for (const pid of [closeHost.provider!, ...closeHost.escaped!]) {
          const stat = `/proc/${pid}/stat`;
          expect(!existsSync(stat) || /\) Z /.test(readFileSync(stat, 'utf8'))).toBe(true);
        }
        expect(() => process.kill(sibling.pid!, 0)).not.toThrow();
        expect(readFileSync(join(siblingLeaf, 'cgroup.events'), 'utf8')).toMatch(/^populated 1$/m);
      } finally {
        ownRoot ??= events.find((event) => event.kind === 'root')?.root;
        // Cleanup is confined to the unique scope this test created.
        if (ownRoot?.endsWith(`/${unit}`) && existsSync(join(ownRoot, 'cgroup.kill'))) {
          writeFileSync(join(ownRoot, 'cgroup.kill'), '1');
        } else if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await closed;
        if (ownRoot?.endsWith(`/${unit}`)) {
          await vi.waitFor(() => expect(existsSync(ownRoot!)).toBe(false), { timeout: 5_000 });
        }
      }
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  },
);
