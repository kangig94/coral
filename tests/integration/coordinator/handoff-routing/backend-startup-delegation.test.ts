import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  handoffRoutingStatusStoreSchema,
  readHandoffRoutingStatus,
  type HandoffRoutingInvocationStatus,
} from '#src/coordinator/handoff-routing/status.js';
import { observeProcessLiveness } from '#src/infra/node-process.js';
import { handoffRoutingStatusPathForRunDir } from '#src/infra/path/coordinator.js';
import { pluginRootNamespace } from '#src/infra/plugin-identity.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { encodeActiveStoreSelection, resolveActiveStoreRecordPaths } from '#src/store/active-store-selection.js';
import { handoffRoutingStatusGeneration } from '#src/store/handoff-routing-status-store/index.js';
import {
  assertBuildArtifactsAvailable,
  coordinatorFilesForHome,
  createPluginFixture,
} from '#tests/integration/coordinator/helpers.js';
import { waitForCondition } from '#tests/support/wait-for-condition.js';

const roots: string[] = [];
const children = new Set<ChildProcess>();
const observedPids = new Set<number>();
const observedPidPaths: string[] = [];
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

type FixtureManifest = Readonly<{
  version: string;
  buildSetId: string;
  bundleHash: string;
  cliBundleHash: string;
  claudeAppserverBundleHash: string;
  flavor: 'prod';
  storeFormatFingerprint: string;
}>;

type InstalledBundle = Readonly<{
  bundleDir: string;
  manifest: FixtureManifest;
}>;

function nextPatchVersion(version: string): string {
  const match = /^(\d+)\.(\d+)\.(\d+)/u.exec(version);
  if (match === null) throw new Error(`Expected a semantic product version, received ${version}`);
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

/**
 * A delegated build must be installed at its own plugin root, as a real one is: a bundle parked beside the
 * invoking build's `bridge/` inherits that build's plugin root, and with it the namespace and the manifest a
 * delegated build must not share.
 */
function installBundle(version: string, bundleHashMarker: string): InstalledBundle {
  const fixture = createPluginFixture(roots, { flavor: 'prod', version, bundleHash: bundleHashMarker });
  const bundleDir = join(fixture.root, 'bridge');
  const manifest = JSON.parse(readFileSync(join(bundleDir, 'manifest.json'), 'utf-8')) as FixtureManifest;
  return { bundleDir, manifest };
}

function encodedSelection(bundle: InstalledBundle): Uint8Array {
  return encodeActiveStoreSelection({
    version: 1,
    manifest: bundle.manifest,
    bundleDir: bundle.bundleDir,
    activeStoreFingerprint: bundle.manifest.storeFormatFingerprint,
  });
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

  for (const path of observedPidPaths.splice(0)) {
    if (existsSync(path)) observedPids.add(Number(readFileSync(path, 'utf-8')));
  }

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
      const selected = installBundle(nextPatchVersion(directManifest.version), 'delegated-backend');
      const { bundleDir: selectedBundleDir, manifest: selectedManifest } = selected;
      expect(selectedManifest.bundleHash).not.toBe(directManifest.bundleHash);
      expect(pluginRootNamespace(dirname(selectedBundleDir))).not.toBe(pluginRootNamespace(direct.root));

      const runtime = createRealRuntime('prod', { baseDir: join(home, '.coral') });
      const selectionPaths = resolveActiveStoreRecordPaths(runtime);
      mkdirSync(selectionPaths.coordinationRoot, { recursive: true, mode: 0o700 });
      expect(
        runtime.storage.writeAtomicDurableSync(selectionPaths.selectionFile, encodedSelection(selected), {
          mode: 0o600,
        }),
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
        // The delegated child's own terminal is not a fact about why the coordinator is unreachable: 23 is
        // the code the crash fixture exits with and SIGTERM the signal the signal fixture raises. The code
        // is bounded to a free-standing token so a pid, duration, path or `file:line:col` that merely
        // contains those digits cannot fail this for the wrong reason.
        // see CORAL_DELEGATION_MODE in tests/fixtures/backend-startup-delegation-preload.cjs
        const reported = run.stderr();
        expect(status).not.toBe(0);
        expect(status).not.toBe(23);
        expect(reported).toContain('[code=backend_unreachable]');
        expect(reported).not.toMatch(/(?<![\w.:-])23(?![\w.:-])/u);
        expect(reported).not.toContain('SIGTERM');
      }
    },
    120_000,
  );

  it('keeps the original delegation pending until a second-hop refusal reaches the operator', async () => {
    assertBuildArtifactsAvailable();
    const home = mkdtempSync(join(tmpdir(), 'coral-transitive-delegation-home-'));
    roots.push(home);
    const direct = createPluginFixture(roots, { flavor: 'prod' });
    const directManifest = JSON.parse(
      readFileSync(join(direct.root, 'bridge', 'manifest.json'), 'utf-8'),
    ) as FixtureManifest;
    const selected = installBundle(nextPatchVersion(directManifest.version), 'transitive-selected-backend');
    const terminal = installBundle(nextPatchVersion(selected.manifest.version), 'transitive-terminal-backend');
    const ambient = installBundle(nextPatchVersion(terminal.manifest.version), 'transitive-ambient-backend');
    expect(selected.manifest.bundleHash).not.toBe(directManifest.bundleHash);
    expect(terminal.manifest.bundleHash).not.toBe(selected.manifest.bundleHash);
    expect(ambient.manifest.bundleHash).not.toBe(terminal.manifest.bundleHash);
    const namespaces = [
      direct.root,
      dirname(selected.bundleDir),
      dirname(terminal.bundleDir),
      dirname(ambient.bundleDir),
    ].map(pluginRootNamespace);
    expect(new Set(namespaces).size).toBe(namespaces.length);

    const runtime = createRealRuntime('prod', { baseDir: join(home, '.coral') });
    const selectionPaths = resolveActiveStoreRecordPaths(runtime);
    mkdirSync(selectionPaths.coordinationRoot, { recursive: true, mode: 0o700 });
    expect(
      runtime.storage.writeAtomicDurableSync(selectionPaths.selectionFile, encodedSelection(selected), {
        mode: 0o600,
      }),
    ).toBe(true);
    const terminalSelectionPath = join(home, 'terminal-selection.json');
    const ambientSelectionPath = join(home, 'ambient-selection.json');
    writeFileSync(terminalSelectionPath, encodedSelection(terminal), { encoding: 'utf-8', mode: 0o600 });
    writeFileSync(ambientSelectionPath, encodedSelection(ambient), { encoding: 'utf-8', mode: 0o600 });

    const files = coordinatorFilesForHome(home, 'prod');
    const gatePath = join(home, 'transitive-refusal.gate');
    const observationPath = join(home, 'transitive-refusal.jsonl');
    const ambientPidPath = join(home, 'ambient.pid');
    observedPidPaths.push(ambientPidPath);
    const selectedBackendPath = join(selected.bundleDir, 'coral-backend.cjs');
    const terminalBackendPath = join(terminal.bundleDir, 'coral-backend.cjs');
    const ambientBackendPath = join(ambient.bundleDir, 'coral-backend.cjs');
    const nodeOptions = [process.env.NODE_OPTIONS, `--require=${preloadPath}`].filter(Boolean).join(' ');
    const run = startCli(direct.root, {
      ...topLevelEnvironment(),
      HOME: home,
      TMPDIR: home,
      NODE_OPTIONS: nodeOptions,
      CORAL_DELEGATION_SELECTED_BACKEND: terminalBackendPath,
      CORAL_DELEGATION_EXPECTED_SOCKET: files.socketPath,
      CORAL_DELEGATION_GATE: gatePath,
      CORAL_DELEGATION_OBSERVATION: observationPath,
      CORAL_DELEGATION_MODE: 'refusal',
      CORAL_DELEGATION_SELECTION_SWITCH_BACKEND: selectedBackendPath,
      CORAL_DELEGATION_NEXT_SELECTION: terminalSelectionPath,
      CORAL_DELEGATION_SELECTION: selectionPaths.selectionFile,
      CORAL_DELEGATION_AMBIENT_BACKEND: ambientBackendPath,
      CORAL_DELEGATION_AMBIENT_SELECTION: ambientSelectionPath,
      CORAL_DELEGATION_AMBIENT_INFO: files.infoFile,
      CORAL_DELEGATION_AMBIENT_PID: ambientPidPath,
    });

    await Promise.race([
      waitForCondition(() => observations(observationPath).some((entry) => entry.event === 'entered'), 30_000),
      run.completed.then((status) => {
        throw new Error(
          `CLI exited with ${status} before the second-hop refusal reached the fixture\nstdout:\n${run.stdout()}\nstderr:\n${run.stderr()}`,
        );
      }),
    ]);
    const entered = observations(observationPath).find((entry) => entry.event === 'entered');
    if (entered !== undefined) observedPids.add(entered.pid);
    const ambientDiscovery = JSON.parse(readFileSync(files.infoFile, 'utf-8')) as Readonly<{ pid: number }>;
    observedPids.add(ambientDiscovery.pid);
    expect(entered).toMatchObject({ mode: 'refusal', requestedAddress: files.socketPath });
    expect(ambientDiscovery.pid).not.toBe(entered?.pid);
    expect(observeProcessLiveness(ambientDiscovery.pid)).toBe('alive');

    await expectPending(run, 250);
    writeFileSync(gatePath, 'release', 'utf-8');
    const status = await run.completed;
    expect(observations(observationPath)).toContainEqual(
      expect.objectContaining({ event: 'released', mode: 'refusal', requestedAddress: files.socketPath }),
    );
    expect(status).toBe(75);
    expect(run.stderr()).toContain('[code=handoff_socket_holder_unverified]');
    expect(run.stderr()).toContain(
      `Handoff refused at the startup deadline for socket ${files.socketPath}: the socket remained bound but no verified holder pid was available.`,
    );

    // The first hop is published by the detached backend the CLI spawned, which outlives it, so the CLI's
    // exit does not order that write.
    const readOriginalDisposition = (): HandoffRoutingInvocationStatus | undefined => {
      const status = readHandoffRoutingStatus(
        runtime,
        handoffRoutingStatusPathForRunDir(
          files.runDir,
          handoffRoutingStatusGeneration(handoffRoutingStatusStoreSchema()),
        ),
      );
      if (status.kind !== 'current') return undefined;
      return status.statuses.find((entry) => {
        if (entry.kind !== 'terminal' || entry.selection === null) return false;
        const disposition = entry.selection.disposition;
        return (
          disposition.kind === 'handoff-selected' &&
          disposition.target.build.bundleHash === selected.manifest.bundleHash
        );
      });
    };
    await waitForCondition(() => readOriginalDisposition() !== undefined, 30_000);
    const originalDisposition = readOriginalDisposition();
    // A backend that refuses startup exits 1: only the CLI envelope maps a documented code to its exit
    // code, so the refusal's class travels in the sentinel, not in the child's process status. What this
    // record must show is that the first hop ended on its child's terminal outcome rather than being
    // finalized as a success by some other coordinator.
    expect(originalDisposition).toMatchObject({
      kind: 'terminal',
      terminal: {
        disposition: {
          kind: 'delegated-exit',
          version: selected.manifest.version,
        },
      },
    });
  }, 120_000);
});
