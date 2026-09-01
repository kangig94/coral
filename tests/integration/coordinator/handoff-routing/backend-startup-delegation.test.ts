import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { observeProcessLiveness } from '#src/infra/node-process.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { encodeActiveStoreSelection, resolveActiveStoreRecordPaths } from '#src/store/active-store-selection.js';
import {
  assertBuildArtifactsAvailable,
  coordinatorFilesForHome,
  createPluginFixture,
} from '#tests/integration/coordinator/helpers.js';
import { waitForCondition } from '#tests/support/wait-for-condition.js';

const roots: string[] = [];
const children = new Set<ChildProcess>();
const observedPids = new Set<number>();
const preloadPath = join(process.cwd(), 'tests', 'fixtures', 'backend-startup-delegation-preload.cjs');

type DelegationMode = 'ready' | 'refusal' | 'crash' | 'signal';

type CliRun = Readonly<{
  child: ChildProcess;
  stdout(): string;
  stderr(): string;
  completed: Promise<number>;
}>;

type Observation = Readonly<{
  event: 'entered' | 'released';
  pid: number;
  mode: DelegationMode;
  requestedAddress: string;
}>;

function nextPatchVersion(version: string): string {
  const match = /^(\d+)\.(\d+)\.(\d+)/u.exec(version);
  if (match === null) throw new Error(`Expected a semantic product version, received ${version}`);
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

function observations(path: string): Observation[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8')
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Observation);
}

function topLevelEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  delete environment.CORAL_CHILD;
  delete environment.CORAL_CHILD_PRINCIPAL_HANDLE;
  delete environment.CORAL_JOB_ID;
  delete environment.CORAL_SESSION_ID;
  delete environment.CORAL_CLI_HANDOFF_DELEGATED;
  delete environment.CORAL_BACKEND_DISABLE_AUTOSTART;
  return environment;
}

function startCli(root: string, env: NodeJS.ProcessEnv): CliRun {
  const child = spawn(process.execPath, [join(root, 'bridge', 'coral-cli.cjs'), 'abort', '--all'], {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  child.once('close', () => children.delete(child));
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const completed = new Promise<number>((resolve, reject) => {
    let timeoutError: Error | null = null;
    const timeout = setTimeout(() => {
      timeoutError = new Error(`CLI timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`);
      child.kill('SIGKILL');
    }, 90_000);
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timeout);
      if (timeoutError !== null) reject(timeoutError);
      else resolve(code ?? -1);
    });
  });
  return { child, stdout: () => stdout, stderr: () => stderr, completed };
}

async function expectPending(run: CliRun, durationMs: number): Promise<void> {
  const outcome = await Promise.race([
    run.completed.then((status) => ({ kind: 'completed' as const, status })),
    new Promise<{ kind: 'pending' }>((resolve) => {
      setTimeout(() => resolve({ kind: 'pending' }), durationMs);
    }),
  ]);
  expect(outcome).toEqual({ kind: 'pending' });
}

afterEach(async () => {
  await Promise.all(
    [...children].map(
      (child) =>
        new Promise<void>((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) {
            resolve();
            return;
          }
          child.once('close', () => resolve());
          child.kill('SIGKILL');
        }),
    ),
  );
  children.clear();

  for (const pid of observedPids) {
    if (observeProcessLiveness(pid) !== 'absent') {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // A process that already exited must not fail the teardown that was reaping it.
      }
    }
  }
  await Promise.all(
    [...observedPids].map((pid) =>
      waitForCondition(() => observeProcessLiveness(pid) === 'absent', 5_000).catch(() => {}),
    ),
  );
  observedPids.clear();

  for (const root of roots.splice(0).reverse()) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('real backend-startup delegation', () => {
  it.each<DelegationMode>(['ready', 'refusal', 'crash', 'signal'])(
    'keeps the CLI alive past 100 ms and follows delegated %s to readiness or terminal outcome',
    async (mode) => {
      assertBuildArtifactsAvailable();
      const home = mkdtempSync(join(tmpdir(), 'coral-delegation-home-'));
      roots.push(home);
      const direct = createPluginFixture(roots, { flavor: 'prod' });
      const directManifest = JSON.parse(
        readFileSync(join(direct.root, 'bridge', 'manifest.json'), 'utf-8'),
      ) as Readonly<{ version: string; bundleHash: string; storeFormatFingerprint: string }>;
      const selectedFixture = createPluginFixture(roots, {
        flavor: 'prod',
        version: nextPatchVersion(directManifest.version),
        bundleHash: 'delegated-backend',
      });
      const selectedBundleDir = join(direct.root, 'selected-bridge');
      renameSync(join(selectedFixture.root, 'bridge'), selectedBundleDir);
      const selectedManifestPath = join(selectedBundleDir, 'manifest.json');
      const selectedManifest = JSON.parse(readFileSync(selectedManifestPath, 'utf-8')) as Readonly<{
        version: string;
        buildSetId: string;
        bundleHash: string;
        cliBundleHash: string;
        claudeAppserverBundleHash: string;
        flavor: 'prod';
        storeFormatFingerprint: string;
      }>;
      expect(selectedManifest.bundleHash).not.toBe(directManifest.bundleHash);

      const runtime = createRealRuntime('prod', { baseDir: join(home, '.coral') });
      const selectionPaths = resolveActiveStoreRecordPaths(runtime);
      mkdirSync(selectionPaths.coordinationRoot, { recursive: true, mode: 0o700 });
      expect(
        runtime.storage.writeAtomicDurableSync(
          selectionPaths.selectionFile,
          encodeActiveStoreSelection({
            version: 1,
            manifest: selectedManifest,
            bundleDir: selectedBundleDir,
            activeStoreFingerprint: selectedManifest.storeFormatFingerprint,
          }),
          { mode: 0o600 },
        ),
      ).toBe(true);

      const files = coordinatorFilesForHome(home, 'prod');
      const gatePath = join(home, `delegation-${mode}.gate`);
      const observationPath = join(home, `delegation-${mode}.jsonl`);
      const selectedBackendPath = join(selectedBundleDir, 'coral-backend.cjs');
      const nodeOptions = [process.env.NODE_OPTIONS, `--require=${preloadPath}`].filter(Boolean).join(' ');
      const run = startCli(direct.root, {
        ...topLevelEnvironment(),
        HOME: home,
        TMPDIR: home,
        NODE_OPTIONS: nodeOptions,
        CORAL_DELEGATION_SELECTED_BACKEND: selectedBackendPath,
        CORAL_DELEGATION_EXPECTED_SOCKET: files.socketPath,
        CORAL_DELEGATION_GATE: gatePath,
        CORAL_DELEGATION_OBSERVATION: observationPath,
        CORAL_DELEGATION_MODE: mode,
      });

      await Promise.race([
        waitForCondition(() => observations(observationPath).some((entry) => entry.event === 'entered'), 30_000),
        run.completed.then((status) => {
          throw new Error(
            `CLI exited with ${status} before delegated startup reached the fixture\nstdout:\n${run.stdout()}\nstderr:\n${run.stderr()}`,
          );
        }),
      ]);
      const entered = observations(observationPath).find((entry) => entry.event === 'entered');
      if (entered !== undefined) observedPids.add(entered.pid);
      expect(entered).toMatchObject({ mode, requestedAddress: files.socketPath });

      await expectPending(run, 250);
      writeFileSync(gatePath, 'release', 'utf-8');
      const status = await run.completed;
      expect(observations(observationPath)).toContainEqual(
        expect.objectContaining({ event: 'released', mode, requestedAddress: files.socketPath }),
      );

      if (mode === 'ready') {
        expect(status).toBe(0);
        expect(run.stderr()).not.toContain('backend_unreachable');
        await waitForCondition(() => existsSync(files.infoFile), 10_000);
        const discovery = JSON.parse(readFileSync(files.infoFile, 'utf-8')) as Readonly<{ pid: number }>;
        observedPids.add(discovery.pid);
        expect(discovery.pid).toBe(entered?.pid);
        expect(observeProcessLiveness(discovery.pid)).toBe('alive');
      } else if (mode === 'refusal') {
        expect(status).toBe(75);
        expect(run.stderr()).toContain('[code=handoff_socket_holder_unverified]');
        expect(run.stderr()).toContain(
          `Handoff refused at the startup deadline for socket ${files.socketPath}: the socket remained bound but no verified holder pid was available.`,
        );
      } else {
        expect(status).not.toBe(0);
        expect(run.stderr()).toContain('[code=backend_unreachable]');
        expect(run.stderr()).not.toContain('23');
        expect(run.stderr()).not.toContain('SIGTERM');
      }
    },
    120_000,
  );
});
