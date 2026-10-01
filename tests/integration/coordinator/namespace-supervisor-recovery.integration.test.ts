import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build, buildSync, type PluginBuild } from 'esbuild';
import { describe, expect, it, vi } from 'vitest';

import { SupervisorEvidence } from '#tests/support/supervisor-evidence.js';
import { childHasExited } from '#src/coordinator-launch/child-state.js';
import { replacementServing } from '#src/coordinator-launch/health.js';
import { observeProcessLiveness, probeProcessIncarnation, type ProcessIncarnation } from '#src/infra/node-process.js';
import { readLaunchStatus } from '#src/infra/launch-status.js';
import {
  launchAdmissionPath,
  listLaunchAdmissions,
  listLaunchSubjects,
  readLaunchAdmission,
} from '#src/infra/launch-admission-record.js';
import { SupervisorLaunchMemory } from '#src/coordinator-launch/state.js';
import * as admissionRecords from '#src/infra/launch-admission-record.js';
import { attemptExclusiveFileLockSync } from '#src/infra/fs-lock.js';
import {
  CURRENT_STRICT_BUNDLE_MANIFEST_FILE,
  SUCCESSION_CAPABILITIES_FILE,
} from '#src/infra/bundle-manifest-address.js';
import { coordinatorPaths, socketPathForRunDir, supervisorLockPath } from '#src/infra/path/coordinator.js';
import { compareAndSwapUpgradeIntent, readUpgradeIntent } from '#src/infra/upgrade-intent.js';
import { readHandoffCapsuleFile } from '#src/provider-proxy/handoff-capsule.js';
import { createRealRuntime } from '#src/runtime/real.js';
import {
  createPluginFixture as createBasePluginFixture,
  createShippedPluginFixture,
  spawnCoordinator as spawnFixtureCoordinator,
  waitForDiscoveryRecord,
  waitForProcessExit,
} from '#tests/integration/coordinator/helpers.js';
import { waitForCondition } from '#tests/support/wait-for-condition.js';
import { topLevelCliEnvironment } from '#tests/support/top-level-cli-environment.js';

function createPluginFixture(...args: Parameters<typeof createBasePluginFixture>) {
  const fixture = createBasePluginFixture(...args);
  buildSync({
    entryPoints: [fileURLToPath(new URL('./fixtures/namespace-supervisor-harness.ts', import.meta.url))],
    outfile: join(fixture.root, 'bridge', 'coral-sentinel.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['node:*'],
    banner: { js: 'var __fixtureImportMetaUrl=require("url").pathToFileURL(__filename).href;' },
    define: { 'import.meta.url': '__fixtureImportMetaUrl' },
  });
  return fixture;
}

function buildSetId(root: string): string {
  return (
    JSON.parse(readFileSync(join(root, 'bridge', CURRENT_STRICT_BUNDLE_MANIFEST_FILE), 'utf8')) as {
      buildSetId: string;
    }
  ).buildSetId;
}

function admittedBuild(root: string): string {
  const manifest = JSON.parse(readFileSync(join(root, 'bridge', CURRENT_STRICT_BUNDLE_MANIFEST_FILE), 'utf8')) as {
    version: string;
    buildSetId: string;
    bundleHash: string;
    flavor: 'prod' | 'dev';
  };
  return JSON.stringify({
    version: manifest.version,
    buildSetId: manifest.buildSetId,
    bundleHash: manifest.bundleHash,
    flavor: manifest.flavor,
  });
}

async function buildObservedSupervisor(outfile: string): Promise<void> {
  await build({
    entryPoints: [fileURLToPath(new URL('./fixtures/namespace-supervisor-harness.ts', import.meta.url))],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['node:*'],
    banner: { js: 'var __fixtureImportMetaUrl=require("url").pathToFileURL(__filename).href;' },
    define: { 'import.meta.url': '__fixtureImportMetaUrl' },
    plugins: [
      {
        name: 'observe-recovery-transitions',
        setup(builder) {
          builder.onLoad({ filter: /\/coordinator-launch\/(state|supervisor)\.ts$/ }, ({ path }) => {
            let source = readFileSync(path, 'utf8');
            const log = `if (process.env.CORAL_FIXTURE_MEMORY_LOG) fixtureAppend(process.env.CORAL_FIXTURE_MEMORY_LOG, JSON.stringify({ kind: 'memory', pid: process.pid, authority: this.#authority, state: this.#state }) + '\\n');`;
            if (path.endsWith('/state.ts')) {
              source = source
                .replace('return this.#state;', `${log} return this.#state;`)
                .replace(
                  'return this.#reserve(owner, buildSetId, purpose, false);',
                  `if (process.env.CORAL_FIXTURE_MEMORY_LOG) fixtureAppend(process.env.CORAL_FIXTURE_MEMORY_LOG, JSON.stringify({ kind: 'reservation', pid: process.pid, authority: this.#authority, state: this.#state }) + '\\n'); return this.#reserve(owner, buildSetId, purpose, false);`,
                );
            } else {
              source = source
                .replace(
                  "process.send?.({ kind: 'coral-recovery-owned', challenge: recoveryChallenge });",
                  "process.send?.({ kind: 'coral-recovery-owned', challenge: recoveryChallenge }, () => fixtureFreeze('owned'));",
                )
                .replace(
                  "process.send?.({ kind: 'coral-repair-bridge-ready', challenge: recoveryChallenge });",
                  "process.send?.({ kind: 'coral-repair-bridge-ready', challenge: recoveryChallenge }, () => fixtureFreeze('bridge', record));",
                )
                .replace(
                  'process.kill(child.pid, signal);',
                  `if (process.env.CORAL_FIXTURE_MEMORY_LOG) fixtureAppend(process.env.CORAL_FIXTURE_MEMORY_LOG, JSON.stringify({ kind: 'signal', pid: child.pid, signal }) + '\\n'); process.kill(child.pid, signal);`,
                );
              source += `\nfunction fixtureFreeze(phase: string, record?: SupervisorLaunchMemory): void {
              const marker = process.env.CORAL_FIXTURE_FREEZE_MARKER;
              if (marker && phase === process.env.CORAL_FIXTURE_RECOVERY_FREEZE && !existsSync(marker)) {
                if (phase === 'bridge' && record?.read().attempt?.admissionProven !== true) {
                  setTimeout(() => fixtureFreeze(phase, record), 20);
                  return;
                }
                fixtureWrite(marker, JSON.stringify({ pid: process.pid, phase, at: Date.now() }));
                process.kill(process.pid, 'SIGSTOP');
              }
            }`;
            }
            return {
              contents: `import { appendFileSync as fixtureAppend, writeFileSync as fixtureWrite } from 'node:fs';\n${source}`,
              loader: 'ts',
            };
          });
        },
      },
    ],
  });
}

type MemoryObservation = {
  kind: 'memory' | 'reservation' | 'signal' | 'replacement-signal' | 'parent-signal';
  pid: number;
  at?: number;
  monotonicAt?: number;
  target?: number;
  parent?: number;
  signal?: string;
  exitCode?: number | null;
  signalCode?: string | null;
  authority: boolean;
  state: ReturnType<SupervisorLaunchMemory['read']>;
};

function memoryObservations(path: string): MemoryObservation[] {
  if (!existsSync(path)) return [];
  const contents = readFileSync(path, 'utf8');
  const end = contents.lastIndexOf('\n');
  if (end < 0) return [];
  return contents
    .slice(0, end)
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as MemoryObservation);
}

function namespaceLockHolders(runDir: string): number[] {
  const { dev, ino } = statSync(supervisorLockPath(runDir), { bigint: true });
  const major = ((dev >> 8n) & 0xfffn) | ((dev >> 32n) & 0xfffff000n);
  const minor = (dev & 0xffn) | ((dev >> 12n) & 0xffffff00n);
  return [
    ...new Set(
      readFileSync('/proc/locks', 'utf8')
        .split('\n')
        .flatMap((line) => {
          const match = /^\d+:\s+POSIX\s+ADVISORY\s+WRITE\s+(\d+)\s+([0-9a-f]+):([0-9a-f]+):(\d+)\s/u.exec(line);
          return match !== null &&
            BigInt(match[4]) === ino &&
            BigInt(`0x${match[2]}`) === major &&
            BigInt(`0x${match[3]}`) === minor
            ? [Number(match[1])]
            : [];
        }),
    ),
  ];
}

async function waitForReplacementLockHolder(
  record: SupervisorEvidence,
  previousPid: number | undefined,
  timeoutMs: number,
): Promise<number> {
  let replacementPid = 0;
  await waitForCondition(() => {
    const holder = record.lockHolder();
    if (holder === null || holder.pid === previousPid) return false;
    replacementPid = holder.pid;
    return true;
  }, timeoutMs);
  return replacementPid;
}

describe('namespace supervisor recovery', () => {
  it('restores a dead shipped-incumbent observer on the first CLI ensure and upgrades after natural idle retirement', async () => {
    const roots: string[] = [];
    const home = mkdtempSync(join(tmpdir(), 'coral-legacy-observer-loss-'));
    roots.push(home);
    const shipped = createShippedPluginFixture(roots, 'v0.10.13');
    const target = createPluginFixture(roots, { flavor: 'prod', version: '0.10.16' });
    const log = join(home, 'memory.jsonl');
    await buildObservedSupervisor(join(target.root, 'bridge', 'coral-sentinel.cjs'));
    const incumbent = spawnFixtureCoordinator({
      fixture: shipped,
      home,
      tempRoots: roots,
      env: { CORAL_BACKEND_IDLE_MS: '1000' },
    });
    const naturalExit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
      incumbent.child.once('exit', (code, signal) => resolve({ code, signal })),
    );
    const runDir = coordinatorPaths('prod', { baseDir: join(home, '.coral') }).runDir;
    const evidence = new SupervisorEvidence(runDir, log);
    const pids = new Set<number>();
    let contender: ReturnType<typeof spawnFixtureCoordinator> | undefined;
    try {
      const initial = await waitForDiscoveryRecord(home, 'prod', 20_000);
      pids.add(initial.pid);
      contender = spawnFixtureCoordinator({
        fixture: target,
        home,
        tempRoots: roots,
        env: { CORAL_FIXTURE_MEMORY_LOG: log },
      });
      expect(await waitForProcessExit(contender, 10_000)).toEqual({ code: 0, signal: null });
      await waitForCondition(() => evidence.lockHolder() !== null, 5_000);
      const lost = evidence.lockHolder()!.pid;
      pids.add(lost);
      expect(readUpgradeIntent(runDir)).toMatchObject({ kind: 'readable', intent: { legacyRetirement: true } });
      process.kill(lost, 'SIGKILL');
      await waitForCondition(() => observeProcessLiveness(lost) === 'absent', 5_000);
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(evidence.lockHolder()).toBeNull();
      expect(probeProcessIncarnation(initial.pid)).toBe(initial.incarnation);
      const trigger = spawn(process.execPath, [join(target.root, 'bridge', 'coral-cli'), 'backend', 'start'], {
        env: topLevelCliEnvironment(home, {
          CLAUDE_PLUGIN_ROOT: target.root,
          CORAL_FIXTURE_MEMORY_LOG: log,
        }),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      trigger.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
      trigger.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
      const triggerExit = await new Promise<number | null>((resolve) => trigger.once('exit', resolve));
      expect(triggerExit, output).toBe(0);
      const restored = evidence.lockHolder();
      expect(
        restored?.pid,
        JSON.stringify({ output, intent: readUpgradeIntent(runDir), memory: memoryObservations(log).slice(-3) }),
      ).toBeDefined();
      expect(restored?.pid).not.toBe(lost);
      pids.add(restored!.pid);
      expect(namespaceLockHolders(runDir)).toEqual([restored!.pid]);
      expect(attemptExclusiveFileLockSync(supervisorLockPath(runDir)).kind).toBe('contended');
      await waitForCondition(
        () =>
          memoryObservations(log).some(
            (event) =>
              event.pid === restored!.pid &&
              event.state?.launch?.child?.pid === initial.pid &&
              event.state.owner.mode === 'recovering',
          ),
        3_000,
      );
      const discoveryPath = join(runDir, 'coordinator.json');
      const shippedDiscovery = readFileSync(discoveryPath, 'utf8');
      writeFileSync(
        discoveryPath,
        JSON.stringify({ ...(JSON.parse(shippedDiscovery) as object), bootToken: 'failed-health-observation' }),
      );
      expect(await replacementServing(runDir, 'prod', initial.pid)).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      expect(await replacementServing(runDir, 'prod', initial.pid)).toBe(false);
      const passive = memoryObservations(log).filter((event) => event.pid === restored!.pid && event.kind === 'memory');
      expect(passive.length).toBeGreaterThan(1);
      expect(passive.every((event) => event.state.launch?.terminationAt === undefined)).toBe(true);
      expect(memoryObservations(log).filter((event) => event.kind === 'signal' && event.pid === initial.pid)).toEqual(
        [],
      );
      expect(listLaunchAdmissions(runDir).filter((entry) => entry.kind === 'readable')).toEqual([]);
      expect(probeProcessIncarnation(initial.pid)).toBe(initial.incarnation);
      writeFileSync(discoveryPath, shippedDiscovery);
      expect(await replacementServing(runDir, 'prod', initial.pid)).toBe(true);
      const retirementStarted = Date.now();
      await waitForCondition(() => observeProcessLiveness(initial.pid) === 'absent', 80_000);
      expect(Date.now() - retirementStarted).toBeLessThan(80_000);
      expect(await naturalExit, incumbent.output()).toEqual({ code: 0, signal: null });
      expect(incumbent.output()).toMatch(/idle/i);
      await waitForCondition(() => evidence.read().launch?.phase === 'serving', 15_000);
      const successor = evidence.read().launch!;
      pids.add(successor.child.pid);
      expect(successor.parent.pid).toBe(restored!.pid);
      expect(successor.buildSetId).toBe(buildSetId(target.root));
      const reservation = memoryObservations(log).find(
        (event) =>
          event.pid === restored!.pid && event.kind === 'reservation' && event.state.owner.mode === 'supervised',
      );
      expect(reservation).toMatchObject({
        authority: true,
        state: { owner: { mode: 'supervised' }, launch: { phase: 'exited' }, attempt: null },
      });
      expect(evidence.lockHolder()?.pid).toBe(restored!.pid);
      expect(memoryObservations(log).filter((event) => event.kind === 'signal' && event.pid === initial.pid)).toEqual(
        [],
      );
    } finally {
      evidence.close();
      contender?.child.kill('SIGKILL');
      incumbent.child.kill('SIGKILL');
      for (const pid of pids) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          continue;
        }
      }
      for (const root of roots.reverse()) rmSync(root, { recursive: true, force: true });
    }
  }, 110_000);

  it.skipIf(process.platform !== 'linux').each(['owned', 'bridge'] as const)(
    'retires a permanently frozen accepted replacement after %s and repairs under exactly one new lock holder',
    async (phase) => {
      const roots: string[] = [];
      const home = mkdtempSync(join(tmpdir(), 'coral-accepted-replacement-freeze-'));
      roots.push(home);
      const plugin = createPluginFixture(roots, {
        flavor: 'prod',
        version: '0.10.14',
        backend: 'supervisor-silence',
        accepts: 'bundled',
      });
      const sentinel = join(plugin.root, 'bridge', 'coral-sentinel.cjs');
      await buildObservedSupervisor(sentinel);
      const runDir = coordinatorPaths('prod', { baseDir: join(home, '.coral') }).runDir;
      const log = join(home, 'memory.jsonl');
      const marker = join(home, 'frozen.json');
      const preload = join(home, 'observe-child-signals.cjs');
      writeFileSync(
        preload,
        `
        const { ChildProcess } = require('node:child_process');
        const { appendFileSync } = require('node:fs');
        const kill = ChildProcess.prototype.kill;
        ChildProcess.prototype.kill = function(signal) {
          appendFileSync(process.env.CORAL_FIXTURE_MEMORY_LOG, JSON.stringify({ kind: 'replacement-signal',
            pid: process.pid, target: this.pid, signal, exitCode: this.exitCode, signalCode: this.signalCode }) + '\\n');
          return kill.call(this, signal);
        };
        const signalProcess = process.kill.bind(process);
        process.kill = function(target, signal) {
          if (signal === 'SIGTERM' || signal === 'SIGKILL')
            appendFileSync(process.env.CORAL_FIXTURE_MEMORY_LOG, JSON.stringify({ kind: 'parent-signal',
              pid: process.pid, parent: process.ppid, target, signal }) + '\\n');
          return signalProcess(target, signal);
        };
      `,
      );
      const evidence = new SupervisorEvidence(runDir, log);
      const supervisor = spawn(process.execPath, [sentinel, join(plugin.root, 'bridge', 'coral-backend.cjs')], {
        env: {
          ...process.env,
          HOME: home,
          TMPDIR: home,
          CORAL_SENTINEL_RUN_DIR: runDir,
          CORAL_FIXTURE_REAL_BACKEND: '1',
          CORAL_FIXTURE_MEMORY_LOG: log,
          CORAL_FIXTURE_RECOVERY_FREEZE: phase,
          CORAL_FIXTURE_FREEZE_MARKER: marker,
          CORAL_FIXTURE_STARTUP_BUDGET_MS: '6000',
          NODE_OPTIONS: `--require=${preload}`,
        },
        stdio: 'ignore',
      });
      const pids = new Set<number>();
      try {
        await waitForCondition(() => evidence.read().launch?.phase === 'serving', 20_000);
        const initial = evidence.read().launch!;
        pids.add(initial.child.pid);
        supervisor.kill('SIGKILL');
        await waitForCondition(() => existsSync(marker), 10_000);
        const frozen = JSON.parse(readFileSync(marker, 'utf8')) as { pid: number; phase: string; at: number };
        pids.add(frozen.pid);
        expect(frozen.phase).toBe(phase);
        expect(evidence.lockHolder()?.pid).toBe(frozen.pid);
        expect(namespaceLockHolders(runDir)).toEqual([frozen.pid]);
        const frozenMemory = memoryObservations(log)
          .reverse()
          .find((event) => event.kind === 'memory' && event.pid === frozen.pid);
        expect(frozenMemory?.state.owner.mode).toBe('recovering');
        expect(attemptExclusiveFileLockSync(supervisorLockPath(runDir)).kind).toBe('contended');
        expect(probeProcessIncarnation(initial.child.pid)).toBe(initial.child.incarnation);
        const survivors = listLaunchAdmissions(runDir).flatMap((entry) =>
          entry.kind === 'readable' ? [entry.admission] : [],
        );
        if (phase === 'bridge') expect(survivors.some((entry) => entry.parent.pid === frozen.pid)).toBe(true);
        for (const admission of survivors) pids.add(admission.child.pid);
        expect(listLaunchAdmissions(runDir)).toContainEqual(
          expect.objectContaining({ kind: 'readable', admission: expect.objectContaining({ child: initial.child }) }),
        );
        expect(await replacementServing(runDir, 'prod', initial.child.pid)).toBe(true);
        const started = frozen.at;
        await waitForCondition(() => observeProcessLiveness(frozen.pid) === 'absent', 8_000);
        const retirement = memoryObservations(log).filter(
          (event) =>
            (event.kind === 'replacement-signal' || event.kind === 'parent-signal') && event.target === frozen.pid,
        );
        const term = retirement.findIndex((event) => event.signal === 'SIGTERM');
        const kill = retirement.findIndex((event) => event.signal === 'SIGKILL');
        expect(term).toBeGreaterThanOrEqual(0);
        expect(kill).toBeGreaterThan(term);
        expect(
          retirement
            .filter((event) => event.kind === 'replacement-signal')
            .every((event) => event.pid === initial.child.pid && event.exitCode === null && event.signalCode === null),
        ).toBe(true);
        expect(
          retirement
            .filter((event) => event.kind === 'parent-signal')
            .every(
              (event) =>
                event.parent === frozen.pid && survivors.some((admission) => admission.child.pid === event.pid),
            ),
        ).toBe(true);
        expect(evidence.lockHolder()?.pid).not.toBe(frozen.pid);
        const restored = await waitForReplacementLockHolder(evidence, frozen.pid, 8_000);
        pids.add(restored);
        expect(namespaceLockHolders(runDir)).toEqual([restored]);
        expect(attemptExclusiveFileLockSync(supervisorLockPath(runDir)).kind).toBe('contended');
        await waitForCondition(
          () =>
            memoryObservations(log).some(
              (event) =>
                event.pid === restored &&
                event.state?.launch?.child?.pid === initial.child.pid &&
                event.state.owner.mode === 'recovering',
            ),
          3_000,
        );
        for (const admission of survivors) {
          if (probeProcessIncarnation(admission.child.pid) !== admission.child.incarnation) continue;
          expect(
            memoryObservations(log).some(
              (event) =>
                event.pid === restored &&
                [event.state?.launch, event.state?.attempt].some(
                  (slot) =>
                    slot?.child?.pid === admission.child.pid && slot.child.incarnation === admission.child.incarnation,
                ),
            ),
          ).toBe(true);
        }
        await waitForCondition(
          () =>
            memoryObservations(log).some(
              (event) =>
                event.pid === restored &&
                event.state?.owner.mode === 'supervised' &&
                event.state.launch?.phase === 'serving' &&
                event.state.launch.child?.pid !== initial.child.pid,
            ),
          15_000,
        );
        expect(Date.now() - started).toBeLessThan(24_000);
        const final = evidence.read();
        pids.add(final.launch!.child.pid);
        expect(final.launch?.parent.pid).toBe(restored);
        expect(final.owner?.mode).toBe('supervised');
        expect(evidence.lockHolder()?.pid).toBe(restored);
        expect(await replacementServing(runDir, 'prod', final.launch!.child.pid)).toBe(true);
      } finally {
        const final = evidence.read();
        for (const pid of [final.owner?.process.pid, final.launch?.child.pid, final.attempt?.child.pid])
          if (pid !== undefined) pids.add(pid);
        evidence.close();
        supervisor.kill('SIGKILL');
        for (const pid of pids) {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            continue;
          }
        }
        for (const root of roots.reverse()) rmSync(root, { recursive: true, force: true });
      }
    },
    55_000,
  );

  it('keeps an intent-only legacy incumbent passive beyond the escalation budget without committing or delivering signals', async () => {
    const roots: string[] = [];
    const home = mkdtempSync(join(tmpdir(), 'coral-passive-intent-incumbent-'));
    roots.push(home);
    const plugin = createPluginFixture(roots, { flavor: 'prod', version: '0.10.16' });
    const runDir = coordinatorPaths('prod', { baseDir: join(home, '.coral') }).runDir;
    const incumbent = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    if (incumbent.pid === undefined) throw new Error('Missing incumbent PID');
    const incarnation = probeProcessIncarnation(incumbent.pid);
    if (incarnation === null) throw new Error('Missing incumbent incarnation');
    const evidence = new SupervisorEvidence(runDir);
    let supervisor: ReturnType<typeof spawn> | undefined;
    const states: ReturnType<SupervisorLaunchMemory['read']>[] = [];
    const signals: unknown[] = [];
    try {
      await evidence.request(join(plugin.root, 'bridge', 'coral-backend.cjs'), buildSetId(plugin.root), {
        instanceId: 'passive',
        pid: incumbent.pid,
        incarnation,
        version: '0.10.13',
        bundleHash: 'legacy',
        flavor: 'prod',
      });
      const harness = join(home, 'supervisor.mjs');
      await build({
        entryPoints: [fileURLToPath(new URL('./fixtures/namespace-supervisor-harness.ts', import.meta.url))],
        outfile: harness,
        bundle: true,
        platform: 'node',
        format: 'esm',
        external: ['node:*'],
        plugins: [
          {
            name: 'observe-supervision-memory',
            setup(builder) {
              builder.onLoad({ filter: /\/coordinator-launch\/(state|supervisor)\.ts$/ }, ({ path }) => ({
                contents: readFileSync(path, 'utf8')
                  .replace(
                    'return this.#state;',
                    "process.send?.({ kind: 'fixture-memory', state: this.#state }); return this.#state;",
                  )
                  .replace(
                    'process.kill(child.pid, signal);',
                    "process.send?.({ kind: 'fixture-signal', pid: child.pid, signal }); process.kill(child.pid, signal);",
                  ),
                loader: 'ts',
              }));
            },
          },
        ],
      });
      supervisor = spawn(process.execPath, [harness, join(plugin.root, 'bridge', 'coral-backend.cjs')], {
        env: { ...process.env, HOME: home, TMPDIR: home, CORAL_SENTINEL_RUN_DIR: runDir },
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      });
      supervisor.on('message', (value: unknown) => {
        if (typeof value !== 'object' || value === null || !('kind' in value)) return;
        if (value.kind === 'fixture-memory' && 'state' in value)
          states.push(value.state as ReturnType<SupervisorLaunchMemory['read']>);
        if (value.kind === 'fixture-signal') signals.push(value);
      });
      await waitForCondition(() => states.length > 0, 3_000);
      expect(evidence.lockHolder()?.pid).toBe(supervisor.pid);
      const started = Date.now();
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(Date.now() - started).toBeGreaterThan(300 + 80);
      expect(states.length).toBeGreaterThan(1);
      expect(
        states.every(
          (state) =>
            state.owner.mode === 'recovering' &&
            state.launch !== null &&
            state.launch?.child?.pid === incumbent.pid &&
            state.launch.parent === undefined &&
            state.launch.terminationAt === undefined,
        ),
      ).toBe(true);
      expect(signals).toEqual([]);
      expect(probeProcessIncarnation(incumbent.pid)).toBe(incarnation);
    } finally {
      evidence.close();
      supervisor?.kill('SIGKILL');
      incumbent.kill('SIGKILL');
      for (const root of roots.reverse()) rmSync(root, { recursive: true, force: true });
    }
  }, 10_000);
  it('holds A and a corrupt pre-discovery B supplied only by intent after supervisor loss, then cleans B after exit', async () => {
    const roots: string[] = [];
    const home = mkdtempSync(join(tmpdir(), 'coral-intent-only-attempt-'));
    roots.push(home);
    const plugin = createPluginFixture(roots, {
      flavor: 'prod',
      version: '0.10.14',
      backend: 'succession-interposition',
      accepts: 'bundled',
    });
    const target = createPluginFixture(roots, {
      flavor: 'prod',
      version: '0.10.16',
      backend: 'admission-freeze',
      accepts: 'bundled',
    });
    const runDir = coordinatorPaths('prod', { baseDir: join(home, '.coral') }).runDir;
    const harness = join(home, 'supervisor.mjs');
    await build({
      entryPoints: [fileURLToPath(new URL('./fixtures/namespace-supervisor-harness.ts', import.meta.url))],
      outfile: harness,
      bundle: true,
      platform: 'node',
      format: 'esm',
      external: ['node:*'],
    });
    const supervisor = spawn(process.execPath, [harness, join(plugin.root, 'bridge', 'coral-backend.cjs')], {
      env: {
        ...process.env,
        HOME: home,
        TMPDIR: home,
        CORAL_SENTINEL_RUN_DIR: runDir,
        CORAL_FIXTURE_REAL_BACKEND: '1',
        CORAL_FIXTURE_PAUSE_AFTER_ADMISSION: join(home, 'paused-admission'),
      },
      stdio: 'ignore',
    });
    const record = new SupervisorEvidence(runDir);
    const pids = new Set<number>();
    let release: (() => void) | undefined;
    try {
      await waitForCondition(() => record.read().launch?.phase === 'serving', 20_000);
      const incumbent = record.read().launch!;
      pids.add(incumbent.child.pid);
      expect(await replacementServing(runDir, 'prod', incumbent.child.pid)).toBe(true);
      const requestedAt = Date.now();
      await record.request(join(target.root, 'bridge', 'coral-backend.cjs'), buildSetId(target.root));
      await waitForCondition(() => existsSync(join(home, 'paused-admission')), 10_000);
      const attempt = record.read().attempt!;
      expect(attempt.id).toBe(readFileSync(join(home, 'paused-admission'), 'utf8'));
      pids.add(attempt.child.pid);
      const subject = listLaunchSubjects(runDir).find((entry) => entry.admission?.launchId === attempt.id)!;
      const intent = readUpgradeIntent(runDir);
      if (intent.kind !== 'readable') throw new Error('Missing intent');
      const attemptId = intent.intent.attemptId ?? attempt.id;
      const deadline = intent.intent.attemptDeadline ?? new Date(attempt.admittedAt + 25_000).toISOString();
      const persisted = await compareAndSwapUpgradeIntent(runDir, intent.intent.revision, {
        ...intent.intent,
        disposition: 'attempting',
        attemptId,
        attemptChild: { attemptId, pid: attempt.child.pid, incarnation: attempt.child.incarnation },
        attemptDeadline: deadline,
      });
      expect(persisted.kind).toBe('written');
      writeFileSync(launchAdmissionPath(runDir, attempt.id), '{');
      expect((JSON.parse(readFileSync(join(runDir, 'coordinator.json'), 'utf8')) as { pid: number }).pid).toBe(
        incumbent.child.pid,
      );
      const parentExit = new Promise<void>((resolve) => supervisor.once('exit', () => resolve()));
      expect(Date.now() - requestedAt).toBeLessThan(8_000);
      supervisor.kill('SIGKILL');
      await parentExit;
      expect(probeProcessIncarnation(attempt.child.pid)).toBe(attempt.child.incarnation);
      const namespace = attemptExclusiveFileLockSync(supervisorLockPath(runDir));
      if (namespace.kind !== 'acquired') throw new Error('Replacement did not acquire the namespace inode');
      release = namespace.lease;
      expect(record.lockHolder()?.pid).toBe(process.pid);
      const incarnation = probeProcessIncarnation(process.pid);
      if (incarnation === null) throw new Error('Missing replacement incarnation');
      const readSubjects = admissionRecords.listLaunchSubjects;
      const unavailable = vi
        .spyOn(admissionRecords, 'listLaunchSubjects')
        .mockImplementation((dir) => readSubjects(dir).filter((entry) => entry.admission?.launchId !== attempt.id));
      expect(probeProcessIncarnation(incumbent.child.pid)).toBe(incumbent.child.incarnation);
      expect(probeProcessIncarnation(attempt.child.pid)).toBe(attempt.child.incarnation);
      const memory = new SupervisorLaunchMemory(runDir, { pid: process.pid, incarnation }, buildSetId(target.root));
      expect(memory.read().launch?.child?.pid).toBe(incumbent.child.pid);
      expect(memory.read().attempt).toMatchObject({
        phase: 'reserved',
        child: attempt.child,
        attemptDeadline: Date.parse(deadline),
      });
      expect(memory.read().attempt?.admittedAt).toBeUndefined();
      expect(memory.reserve(memory.read().owner, 'another-build', 'succession')).toBeNull();
      expect(memory.supervisionEligible(memory.read().attempt!)).toBe(false);
      process.kill(attempt.child.pid, 'SIGKILL');
      await waitForCondition(() => observeProcessLiveness(attempt.child.pid) === 'absent', 5_000);
      unavailable.mockRestore();
      memory.reconcileAdmissions();
      expect(memory.read().attempt?.phase).toBe('exited');
      expect(memory.read().attempt?.attemptDeadline).toBe(Date.parse(deadline));
      expect(existsSync(subject.path)).toBe(false);
      expect(existsSync(subject.lifetimePath!)).toBe(false);
      memory.reconcileAdmissions();
      expect(existsSync(subject.path)).toBe(false);
      expect(probeProcessIncarnation(incumbent.child.pid)).toBe(incumbent.child.incarnation);
    } finally {
      vi.restoreAllMocks();
      release?.();
      record.close();
      supervisor.kill('SIGKILL');
      for (const pid of pids) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          /* Exit may already be established. */
        }
      }
      for (const root of roots.reverse()) rmSync(root, { recursive: true, force: true });
    }
  }, 40_000);
  it('keeps a live coordinator recorded after a child IPC error', async () => {
    const roots: string[] = [];
    const home = mkdtempSync(join(tmpdir(), 'coral-child-ipc-error-'));
    roots.push(home);
    const plugin = createPluginFixture(roots, { flavor: 'prod', version: '0.10.14' });
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
    const supervisor = spawn(process.execPath, [harness, join(plugin.root, 'bridge', 'coral-backend.cjs')], {
      env: { ...process.env, HOME: home, TMPDIR: home, CORAL_SENTINEL_RUN_DIR: runDir },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    const record = new SupervisorEvidence(runDir);
    const pids = new Set<number>();
    try {
      await waitForCondition(() => record.read().launch?.phase === 'serving', 20_000);
      const servingPid = record.read().launch?.child?.pid;
      if (servingPid === undefined) throw new Error('Serving child has no PID');
      pids.add(servingPid);
      supervisor.send('error-coordinator-channel');
      await new Promise((resolve) => setTimeout(resolve, 700));
      expect(record.read().launch).toMatchObject({ phase: 'serving', child: { pid: servingPid } });
      expect(record.read().owner?.process.pid).toBe(supervisor.pid);
    } finally {
      const state = record.read();
      for (const pid of [state.owner?.process.pid, state.launch?.child?.pid]) {
        if (pid !== undefined) pids.add(pid);
      }
      record.close();
      supervisor.kill('SIGKILL');
      for (const pid of pids) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // The fixture may already have exited.
        }
      }
      for (const root of roots.reverse()) rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
  it.runIf(process.platform === 'linux')(
    'retires a disconnected coordinator that wedges before repair',
    async () => {
      const roots: string[] = [];
      const home = mkdtempSync(join(tmpdir(), 'coral-disconnected-wedge-'));
      roots.push(home);
      const plugin = createPluginFixture(roots, { flavor: 'prod', version: '0.10.14' });
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
      const supervisor = spawn(process.execPath, [harness, join(plugin.root, 'bridge', 'coral-backend.cjs')], {
        env: { ...process.env, HOME: home, TMPDIR: home, CORAL_SENTINEL_RUN_DIR: runDir },
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      });
      const record = new SupervisorEvidence(runDir);
      const pids = new Set<number>();
      let stoppedPid: number | undefined;
      try {
        await waitForCondition(() => record.read().launch?.phase === 'serving', 20_000);
        stoppedPid = record.read().launch?.child?.pid;
        if (stoppedPid === undefined) throw new Error('Serving child has no PID');
        pids.add(stoppedPid);
        await new Promise<void>((resolve, reject) =>
          supervisor.send('disconnect-coordinator', (error) => (error ? reject(error) : resolve())),
        );
        process.kill(stoppedPid, 'SIGSTOP');
        await waitForCondition(() => {
          const launch = record.read().launch;
          return launch?.phase === 'serving' && launch.child?.pid !== stoppedPid;
        }, 20_000);
        expect(record.read().owner?.process.pid).toBe(supervisor.pid);
        expect(probeProcessIncarnation(stoppedPid)).toBeNull();
        expect(supervisor.exitCode).toBeNull();
      } finally {
        const state = record.read();
        for (const pid of [state.owner?.process.pid, state.launch?.child?.pid]) if (pid !== undefined) pids.add(pid);
        record.close();
        supervisor.kill('SIGKILL');
        for (const pid of pids) {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            // The fixture may already have exited.
          }
        }
        for (const root of roots.reverse()) rmSync(root, { recursive: true, force: true });
      }
    },
    40_000,
  );
  it.each(['launch', 'serving attempt'] as const)(
    'repairs a disconnected %s coordinator while its original supervisor stays alive and its job survives',
    async (source) => {
      const roots: string[] = [];
      const home = mkdtempSync(join(tmpdir(), 'coral-disconnected-supervisor-'));
      roots.push(home);
      const plugin = createPluginFixture(roots, {
        flavor: 'prod',
        version: '0.10.14',
        backend: 'succession-interposition',
        accepts: 'bundled',
      });
      const successor =
        source === 'serving attempt'
          ? createPluginFixture(roots, {
              flavor: 'prod',
              version: '0.10.15',
              backend: 'succession-interposition',
              accepts: 'bundled',
            })
          : null;
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
      const supervisor = spawn(process.execPath, [harness, join(plugin.root, 'bridge', 'coral-backend.cjs')], {
        env: {
          ...process.env,
          HOME: home,
          TMPDIR: home,
          PATH: `${join(home, 'bin')}:${process.env.PATH ?? ''}`,
          CORAL_SENTINEL_RUN_DIR: runDir,
          CORAL_FIXTURE_REAL_BACKEND: '1',
          ...(successor === null ? {} : { CORAL_TEST_SUCCESSION_RELEASE_DELAY_MS: '10000' }),
        },
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      });
      const record = new SupervisorEvidence(runDir);
      const pids = new Set<number>();
      const hosts: { pid: number; incarnation: ProcessIncarnation }[] = [];
      let cli: ReturnType<typeof spawn> | null = null;
      try {
        await waitForCondition(() => record.read().launch?.phase === 'serving', 20_000);
        const originalPid = record.read().launch?.child?.pid;
        if (originalPid === undefined) throw new Error('Serving child has no PID');
        let initialHealthy = false;
        for (let retry = 0; retry < 100 && !initialHealthy; retry += 1) {
          initialHealthy = await replacementServing(runDir, 'prod', originalPid);
          if (!initialHealthy) await new Promise((resolve) => setTimeout(resolve, 100));
        }
        expect(initialHealthy).toBe(true);
        pids.add(originalPid);
        const binDir = join(home, 'bin');
        const stateDir = join(home, '.fake-codex-state');
        const projectRoot = join(home, 'project');
        mkdirSync(binDir);
        mkdirSync(stateDir);
        mkdirSync(projectRoot);
        mkdirSync(join(home, '.codex'));
        mkdirSync(join(home, '.claude'));
        writeFileSync(
          join(home, '.codex', 'auth.json'),
          JSON.stringify({ tokens: { access_token: 'fake-access-token', account_id: 'fake-account-id' } }),
        );
        const fakeCodex = join(binDir, 'codex');
        copyFileSync(join(process.cwd(), 'tests', 'fixtures', 'transfer-codex-appserver.cjs'), fakeCodex);
        chmodSync(fakeCodex, 0o755);
        const prompt = join(projectRoot, 'prompt.txt');
        writeFileSync(prompt, 'Keep this provider job running during supervisor repair.');
        const launchedCli = spawn(
          'node',
          [join(plugin.root, 'bridge', 'coral-cli'), 'codex', '-i', prompt, '--detach'],
          {
            cwd: projectRoot,
            env: topLevelCliEnvironment(home, { PATH: `${binDir}:${process.env.PATH ?? ''}` }),
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
        cli = launchedCli;
        let cliOutput = '';
        launchedCli.stdout?.on('data', (chunk: Buffer) => (cliOutput += chunk.toString()));
        launchedCli.stderr?.on('data', (chunk: Buffer) => (cliOutput += chunk.toString()));
        await waitForCondition(() => launchedCli.exitCode !== null, 30_000);
        expect(launchedCli.exitCode, cliOutput).toBe(0);
        try {
          await waitForCondition(() => existsSync(join(stateDir, 'job-running')), 30_000);
        } catch (error: unknown) {
          throw new Error(`Provider job did not start: ${cliOutput}`, { cause: error });
        }
        let capsulePath: string | undefined;
        await waitForCondition(() => {
          capsulePath = readdirSync(runDir).find((name) =>
            /^provider-1[0-9a-f]{23}\.handoff\.v[34]\.json$/u.test(name),
          );
          return capsulePath !== undefined;
        }, 20_000);
        if (capsulePath === undefined) throw new Error('Provider host capsule is unavailable');
        const capsule = readHandoffCapsuleFile(join(runDir, capsulePath), {
          storage: createRealRuntime('prod', { baseDir: join(home, '.coral') }).storage,
          uid: process.getuid?.() ?? 0,
        });
        if (capsule === null || (capsule.version !== 3 && capsule.version !== 4))
          throw new Error('Provider host capsule is unreadable');
        hosts.push(
          { pid: capsule.guardianPid, incarnation: capsule.guardianIncarnation },
          { pid: capsule.reaperPid, incarnation: capsule.reaperIncarnation },
          { pid: capsule.proxyPid, incarnation: capsule.proxyIncarnation },
        );
        const jobPid = Number(readFileSync(join(stateDir, 'job-running'), 'utf8'));
        const jobIncarnation = probeProcessIncarnation(jobPid);
        if (jobIncarnation === null) throw new Error('Provider job process has no incarnation');
        hosts.push({ pid: jobPid, incarnation: jobIncarnation });
        const disconnectedAt = Date.now();
        let disconnectedPid = originalPid;
        if (successor === null) supervisor.send('disconnect-coordinator');
        else {
          await record.request(join(successor.root, 'bridge', 'coral-backend.cjs'), buildSetId(successor.root));
          await waitForCondition(() => record.read().attempt?.phase === 'serving', 30_000);
          const attemptPid = record.read().attempt?.child?.pid;
          if (attemptPid === undefined) throw new Error('Serving attempt has no PID');
          disconnectedPid = attemptPid;
          pids.add(attemptPid);
          process.kill(attemptPid, 'SIGUSR2');
        }
        const replacementPid = await waitForReplacementLockHolder(record, supervisor.pid, 10_000);
        if (replacementPid !== undefined) pids.add(replacementPid);
        expect(supervisor.exitCode).toBeNull();
        await waitForCondition(() => {
          const state = record.read();
          const repaired = [state.launch, state.attempt].find((slot) => slot?.child?.pid === disconnectedPid);
          return source === 'launch'
            ? state.launch?.phase === 'serving' &&
                state.launch.child?.pid !== originalPid &&
                state.launch.parent?.pid === replacementPid &&
                state.owner?.mode === 'supervised'
            : state.owner?.process.pid === replacementPid &&
                (repaired?.phase === 'serving' ||
                  (state.launch?.phase === 'serving' &&
                    state.launch.parent.pid === replacementPid &&
                    state.owner?.mode === 'supervised'));
        }, 20_000).catch((error: unknown) => {
          throw new Error(
            `Disconnected child supervision did not converge: ${JSON.stringify(record.read())}; status=${JSON.stringify(readLaunchStatus(runDir))}`,
            { cause: error },
          );
        });
        if (source === 'launch') expect(record.read().owner?.mode).toBe('supervised');
        else {
          await waitForCondition(() => {
            const status = readLaunchStatus(runDir);
            return (
              status.kind === 'readable' &&
              Array.isArray(status.status.inheritedHealth) &&
              status.status.inheritedHealth.some(
                (observation: { supervisor: { pid: number }; child: { pid: number }; observedHealthyAt: number }) =>
                  observation.supervisor.pid === replacementPid &&
                  observation.child.pid === disconnectedPid &&
                  observation.observedHealthyAt > disconnectedAt,
              )
            );
          }, 10_000);
          const state = record.read();
          if (state.owner?.mode === 'supervised') expect(state.launch?.parent.pid).toBe(replacementPid);
          else expect(state.owner?.mode).toBe('recovering');
        }
        expect(hosts.every(({ pid, incarnation }) => probeProcessIncarnation(pid) === incarnation)).toBe(true);
        writeFileSync(join(stateDir, 'release-job'), '');
        await waitForCondition(() => existsSync(join(stateDir, 'terminal-completed')), 20_000);
        if (source === 'serving attempt') {
          try {
            await waitForCondition(() => {
              const state = record.read();
              return (
                state.launch?.phase === 'serving' &&
                state.launch.child?.pid !== disconnectedPid &&
                state.launch.parent?.pid === state.owner?.process.pid &&
                state.owner?.mode === 'supervised'
              );
            }, 30_000);
          } catch (error: unknown) {
            throw new Error(
              `Serving attempt did not complete supervision repair: state=${JSON.stringify(record.read())}; intent=${JSON.stringify(readUpgradeIntent(runDir))}`,
              { cause: error },
            );
          }
        }
      } finally {
        const state = record.read();
        for (const pid of [state.owner?.process.pid, state.launch?.child?.pid, state.attempt?.child?.pid]) {
          if (pid !== undefined) pids.add(pid);
        }
        record.close();
        cli?.kill('SIGKILL');
        supervisor.kill('SIGKILL');
        for (const pid of pids) {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            // The fixture may already have exited.
          }
        }
        for (const { pid, incarnation } of hosts) {
          if (probeProcessIncarnation(pid) !== incarnation) continue;
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            // The provider host may already have exited.
          }
        }
        for (const root of roots.reverse()) rmSync(root, { recursive: true, force: true });
      }
    },
    65_000,
  );
  it('repairs the serving coordinator after an inherited admitted attempt exits', async () => {
    const roots: string[] = [];
    const home = mkdtempSync(join(tmpdir(), 'coral-pending-attempt-repair-'));
    roots.push(home);
    const plugin = createPluginFixture(roots, {
      flavor: 'prod',
      version: '0.10.14',
      backend: 'succession-interposition',
      accepts: 'bundled',
    });
    const target = createPluginFixture(roots, {
      flavor: 'prod',
      version: '0.10.16',
      backend: 'admission-freeze',
      accepts: 'bundled',
    });
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
    const supervisor = spawn(process.execPath, [harness, join(plugin.root, 'bridge', 'coral-backend.cjs')], {
      env: {
        ...process.env,
        HOME: home,
        TMPDIR: home,
        CORAL_SENTINEL_RUN_DIR: runDir,
        CORAL_FIXTURE_REAL_BACKEND: '1',
      },
      stdio: 'ignore',
    });
    const record = new SupervisorEvidence(runDir);
    const pids = new Set<number>();
    let attemptPid: number | undefined;
    try {
      await waitForCondition(() => record.memory()?.launch?.phase === 'serving', 20_000);
      const original = record.read();
      const owner = original.owner;
      const servingPid = original.launch?.child?.pid;
      if (owner === null || servingPid === undefined) throw new Error('Fixture processes are unavailable');
      pids.add(servingPid);
      await record.request(join(target.root, 'bridge', 'coral-backend.cjs'), buildSetId(target.root));
      await waitForCondition(() => record.read().attempt?.phase === 'admitted', 10_000);
      attemptPid = record.read().attempt?.child.pid;
      if (attemptPid === undefined) throw new Error('Attempt has no PID');
      pids.add(attemptPid);
      process.kill(attemptPid, 'SIGSTOP');
      expect(probeProcessIncarnation(servingPid)).toBe(original.launch?.child.incarnation);
      supervisor.kill('SIGKILL');
      let replacementPid: number | undefined;
      await waitForCondition(() => {
        const observed = record.read().owner?.process.pid;
        if (observed === undefined || observed === supervisor.pid) return false;
        replacementPid = observed;
        return true;
      }, 10_000).catch((error: unknown) => {
        throw new Error(
          `Replacement missing: ${JSON.stringify(record.read())}; status=${JSON.stringify(readLaunchStatus(runDir))}; original=${servingPid}; attempt=${attemptPid}`,
          { cause: error },
        );
      });
      if (replacementPid !== undefined) pids.add(replacementPid);
      await waitForCondition(() => record.memory()?.attempt?.child?.pid === attemptPid, 1_000);
      expect(record.memory()).toMatchObject({
        owner: { mode: 'recovering' },
        launch: { child: { pid: servingPid } },
        attempt: { phase: 'admitted', child: { pid: attemptPid } },
      });
      rmSync(target.root, { recursive: true, force: true });
      const retiredAt = Date.now();
      if (probeProcessIncarnation(attemptPid) !== null) process.kill(attemptPid, 'SIGKILL');
      const log = join(home, 'supervisor-memory.jsonl');
      await waitForCondition(
        () =>
          memoryObservations(log).some(
            (event) =>
              event.pid === replacementPid &&
              event.state?.owner.mode === 'recovering' &&
              event.state.launch?.child?.pid === servingPid &&
              event.state.attempt?.child?.pid === attemptPid &&
              event.state.attempt?.phase === 'exited',
          ),
        10_000,
      ).catch((error: unknown) => {
        throw new Error(
          `Attempt exit did not settle: ${JSON.stringify(record.read())}; status=${JSON.stringify(readLaunchStatus(runDir))}`,
          { cause: error },
        );
      });
      expect(
        memoryObservations(log).some(
          (event) =>
            event.pid === replacementPid &&
            event.state?.owner.mode === 'recovering' &&
            event.state.launch?.child?.pid === servingPid &&
            event.state.attempt?.child?.pid === attemptPid &&
            event.state.attempt?.phase === 'exited',
        ),
      ).toBe(true);
      try {
        await waitForCondition(
          () =>
            record.read().launch?.phase === 'serving' &&
            record.read().launch?.child?.pid !== servingPid &&
            record.read().launch?.parent?.pid === replacementPid,
          15_000,
        );
      } catch (error) {
        throw new Error(
          `Recovery did not serve under replacement ${replacementPid}: ${JSON.stringify(record.read())}`,
          { cause: error },
        );
      }
      await waitForCondition(() => record.memory()?.owner.mode === 'supervised', 1_000).catch((error: unknown) => {
        throw new Error(
          `Recovered successor did not normalize: memory=${JSON.stringify(record.memory())}; state=${JSON.stringify(record.read())}; status=${JSON.stringify(readLaunchStatus(runDir))}; recent=${JSON.stringify(memoryObservations(log).slice(-5))}`,
          { cause: error },
        );
      });
      expect(record.memory()?.launch?.parent?.pid).toBe(replacementPid);
      expect(Date.now() - retiredAt).toBeLessThan(26_000);
    } finally {
      const state = record.read();
      for (const pid of [state.owner?.process.pid, state.launch?.child?.pid, state.attempt?.child?.pid]) {
        if (pid !== undefined) pids.add(pid);
      }
      record.close();
      supervisor.kill('SIGKILL');
      for (const pid of pids) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // The fixture may already have exited.
        }
      }
      for (const root of roots.reverse()) rmSync(root, { recursive: true, force: true });
    }
  }, 45_000);
  it.each(['predecessor', 'successor'] as const)(
    'repairs a serving succession when the %s replacement wins, then serves two upgrades',
    async (winner) => {
      const roots: string[] = [];
      const pids = new Set<number>();
      const home = mkdtempSync(join(tmpdir(), 'coral-red-inherited-attempt-'));
      roots.push(home);
      const incumbent = createPluginFixture(roots, {
        flavor: 'prod',
        version: '0.10.14',
        backend: 'succession-interposition',
        accepts: 'bundled',
      });
      const successor = createPluginFixture(roots, {
        flavor: 'prod',
        version: '0.10.15',
        backend: 'succession-interposition',
        accepts: 'bundled',
      });
      const later = createPluginFixture(roots, {
        flavor: 'prod',
        version: '0.10.16',
        backend: 'succession-interposition',
        accepts: 'bundled',
      });
      const last = createPluginFixture(roots, {
        flavor: 'prod',
        version: '0.10.17',
        backend: 'succession-interposition',
        accepts: 'bundled',
      });
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
        env: {
          ...process.env,
          HOME: home,
          TMPDIR: home,
          CORAL_SENTINEL_RUN_DIR: runDir,
          CORAL_TEST_SUCCESSION_RELEASE_DELAY_MS: '5000',
          CORAL_FIXTURE_REAL_BACKEND: '1',
          CORAL_FIXTURE_SUCCESSION_LOG: join(home, 'succession-evidence.jsonl'),
        },
        stdio: 'ignore',
      });
      const record = new SupervisorEvidence(runDir);
      const incumbentBuildSetId = buildSetId(incumbent.root);
      const successorBuildSetId = buildSetId(successor.root);
      const retainedIncumbent = join(home, '.coral', 'gen2', 'builds', incumbentBuildSetId);
      const retainedSuccessor = join(home, '.coral', 'gen2', 'builds', successorBuildSetId);
      const blockedRoot = winner === 'predecessor' ? successor.root : incumbent.root;
      const blockedRetained = winner === 'predecessor' ? retainedSuccessor : retainedIncumbent;
      const heldRoot = join(home, 'held-root');
      const heldRetained = join(home, 'held-retained');
      const rememberProcesses = (): void => {
        const state = record.read();
        for (const process of [
          state.owner?.process,
          state.launch?.parent,
          state.launch?.child,
          state.attempt?.parent,
          state.attempt?.child,
        ]) {
          if (process !== undefined) pids.add(process.pid);
        }
      };

      try {
        await waitForCondition(() => record.read().launch?.phase === 'serving', 20_000);
        await record.request(join(successor.root, 'bridge', 'coral-backend.cjs'), buildSetId(successor.root));
        try {
          await waitForCondition(() => record.read().attempt?.phase === 'serving', 30_000);
        } catch (error: unknown) {
          throw new Error(`Serving attempt was not observed: ${JSON.stringify(record.read())}`, { cause: error });
        }
        rememberProcesses();

        await waitForCondition(() => existsSync(retainedSuccessor) && existsSync(retainedIncumbent), 10_000);
        renameSync(blockedRoot, heldRoot);
        renameSync(blockedRetained, heldRetained);
        supervisor.kill('SIGKILL');
        expect(record.read().attempt).toMatchObject({ phase: 'serving', buildSetId: successorBuildSetId });
        await waitForCondition(() => {
          const owner = record.read().owner;
          return (
            owner?.process.pid !== undefined &&
            owner.process.pid !== supervisor.pid &&
            owner.buildSetId === (winner === 'predecessor' ? incumbentBuildSetId : successorBuildSetId)
          );
        }, 20_000);
        rememberProcesses();
        if (winner === 'predecessor') {
          const state = record.read();
          const child = [state.launch, state.attempt].find((slot) => slot?.buildSetId === successorBuildSetId)?.child;
          if (child === undefined) throw new Error('Serving successor identity is unavailable');
          appendFileSync(
            join(home, 'succession-evidence.jsonl'),
            JSON.stringify({ pid: child.pid, pause: 'begin', at: Date.now() }) + '\n',
          );
          process.kill(child.pid, 'SIGSTOP');
          await new Promise((resolve) => setTimeout(resolve, 700));
          if (observeProcessLiveness(child.pid) !== 'absent') process.kill(child.pid, 'SIGCONT');
          appendFileSync(
            join(home, 'succession-evidence.jsonl'),
            JSON.stringify({ pid: child.pid, pause: 'end', at: Date.now() }) + '\n',
          );
          expect(probeProcessIncarnation(child.pid)).toBe(child.incarnation);
          const recovered = record.memory();
          expect(recovered?.owner.mode).toBe('recovering');
          const slot = [recovered?.launch, recovered?.attempt].find((entry) => entry?.child?.pid === child.pid);
          expect(slot).toBeDefined();
          expect(slot?.terminationAt).toBeUndefined();
        }
        renameSync(heldRoot, blockedRoot);
        renameSync(heldRetained, blockedRetained);
        try {
          await waitForCondition(() => {
            const launch = record.read().launch;
            return launch?.phase === 'serving' && launch.buildSetId === successorBuildSetId;
          }, 20_000);
        } catch (error: unknown) {
          throw new Error(
            `Serving successor was not normalized: ${JSON.stringify(record.read())}\n${readFileSync(join(home, 'succession-evidence.jsonl'), 'utf8')}`,
            { cause: error },
          );
        }
        await waitForCondition(() => {
          const observed = record.read();
          return (
            observed.owner?.buildSetId === successorBuildSetId &&
            observed.launch?.parent?.pid === observed.owner.process.pid
          );
        }, 20_000);
        const requested = await record.request(join(later.root, 'bridge', 'coral-backend.cjs'), buildSetId(later.root));
        try {
          await waitForCondition(
            () =>
              record.read().launch?.phase === 'serving' &&
              record.read().launch?.buildSetId === buildSetId(later.root) &&
              record.read().requests.find((request) => request.id === requested.id)?.status === 'completed',
            15_000,
          );
        } catch (error: unknown) {
          throw new Error(`Later upgrade remained unserved: ${JSON.stringify(record.read())}`, { cause: error });
        }
        const finalRequest = await record.request(
          join(last.root, 'bridge', 'coral-backend.cjs'),
          buildSetId(last.root),
        );
        await waitForCondition(
          () =>
            record.read().launch?.phase === 'serving' &&
            record.read().launch?.buildSetId === buildSetId(last.root) &&
            record.read().requests.find((request) => request.id === finalRequest.id)?.status === 'completed',
          20_000,
        );
        expect(record.read().owner?.mode).toBe('supervised');
        expect(record.read().launch?.parent).toEqual(record.read().owner?.process);
      } finally {
        if (existsSync(heldRoot)) renameSync(heldRoot, blockedRoot);
        if (existsSync(heldRetained)) renameSync(heldRetained, blockedRetained);
        rememberProcesses();
        record.close();
        if (supervisor.exitCode === null) supervisor.kill('SIGKILL');
        for (const pid of pids) {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            // The test process may already have exited.
          }
        }
        for (const root of roots.reverse()) rmSync(root, { recursive: true, force: true });
      }
    },
    90_000,
  );
  it('accepts a later upgrade after promoting an inherited coordinator successor', async () => {
    const roots: string[] = [];
    const home = mkdtempSync(join(tmpdir(), 'coral-inherited-upgrade-chain-'));
    roots.push(home);
    const first = createPluginFixture(roots, { flavor: 'prod', version: '0.10.14', accepts: 'bundled' });
    const second = createPluginFixture(roots, { flavor: 'prod', version: '0.10.15', accepts: 'bundled' });
    const third = createPluginFixture(roots, { flavor: 'prod', version: '0.10.16', accepts: 'bundled' });
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
    const supervisor = spawn(process.execPath, [harness, join(first.root, 'bridge', 'coral-backend.cjs')], {
      env: { ...process.env, HOME: home, TMPDIR: home, CORAL_SENTINEL_RUN_DIR: runDir },
      stdio: 'ignore',
    });
    const record = new SupervisorEvidence(runDir);
    const pids: number[] = [];
    try {
      await waitForCondition(() => record.read().launch?.phase === 'serving', 20_000);
      const firstPid = record.read().launch?.child?.pid;
      if (firstPid === undefined) throw new Error('First coordinator has no PID');
      pids.push(firstPid);
      supervisor.kill('SIGKILL');
      const replacementPid = await waitForReplacementLockHolder(record, supervisor.pid, 10_000);
      if (replacementPid !== undefined) pids.push(replacementPid);
      const next = await record.request(join(second.root, 'bridge', 'coral-backend.cjs'), buildSetId(second.root));
      try {
        await waitForCondition(() => {
          const launch = record.read().launch;
          return launch?.phase === 'serving' && launch.buildSetId === buildSetId(second.root);
        }, 25_000);
      } catch (error) {
        throw new Error(`Later inherited upgrade did not serve: ${JSON.stringify(record.read())}`, { cause: error });
      }

      const secondPid = record.read().launch?.child?.pid;
      if (secondPid !== undefined) pids.push(secondPid);
      await waitForCondition(
        () => record.read().requests.find((entry) => entry.id === next.id)?.status === 'completed',
        5_000,
      );
      const last = await record.request(join(third.root, 'bridge', 'coral-backend.cjs'), buildSetId(third.root));
      await waitForCondition(() => {
        const launch = record.read().launch;
        return launch?.phase === 'serving' && launch.buildSetId === buildSetId(third.root);
      }, 25_000);
      const thirdPid = record.read().launch?.child?.pid;
      if (thirdPid !== undefined) pids.push(thirdPid);
      await waitForCondition(
        () => record.read().requests.find((entry) => entry.id === last.id)?.status === 'completed',
        5_000,
      );
    } finally {
      record.close();
      if (supervisor.exitCode === null) supervisor.kill('SIGKILL');
      for (const pid of pids) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // The coordinator may have exited.
        }
      }
      for (const root of roots.reverse()) rmSync(root, { recursive: true, force: true });
    }
  }, 65_000);
  it.runIf(process.platform === 'linux')(
    'survives an inherited child exiting during its readiness probe',
    async () => {
      const roots: string[] = [];
      const home = mkdtempSync(join(tmpdir(), 'coral-inherited-probe-exit-'));
      roots.push(home);
      const original = createPluginFixture(roots, { flavor: 'prod', version: '0.10.14', accepts: 'bundled' });
      const recovery = createPluginFixture(roots, { flavor: 'prod', version: '0.10.16', accepts: 'bundled' });
      const runDir = coordinatorPaths('prod', { baseDir: join(home, '.coral') }).runDir;
      const fixture = join(home, 'inherited-child.mjs');
      await build({
        entryPoints: [fileURLToPath(new URL('./fixtures/inherited-admission-child.ts', import.meta.url))],
        outfile: fixture,
        bundle: true,
        platform: 'node',
        target: 'node22',
        format: 'esm',
        external: ['node:*'],
      });
      const child = spawn(
        process.execPath,
        [fixture, runDir, admittedBuild(original.root), 'startup', String(process.pid), 'dead-parent', '30000'],
        { stdio: 'ignore' },
      );
      const otherChild = spawn(
        process.execPath,
        [fixture, runDir, admittedBuild(recovery.root), 'succession', String(process.pid), 'dead-parent', '30000'],
        { stdio: 'ignore' },
      );
      const record = new SupervisorEvidence(runDir);
      let supervisor: ReturnType<typeof spawn> | null = null;
      let recoveredPid: number | undefined;
      if (child.pid === undefined) throw new Error('Fixture child has no PID');
      if (otherChild.pid === undefined) throw new Error('Other fixture child has no PID');
      await waitForCondition(() => {
        const { launch, attempt } = record.read();
        return launch?.child.pid === child.pid && attempt?.child.pid === otherChild.pid;
      }, 5_000);
      const server = createServer((socket) => {
        child.kill('SIGKILL');
        rmSync(join(runDir, 'coordinator.json'), { force: true });
        socket.destroy();
        server.close();
      });
      const oldManifest = JSON.parse(
        readFileSync(join(original.root, 'bridge', CURRENT_STRICT_BUNDLE_MANIFEST_FILE), 'utf8'),
      ) as { bundleHash: string };
      const childIncarnation = probeProcessIncarnation(child.pid);
      if (childIncarnation === null) throw new Error('Inherited child incarnation is unavailable');
      const request = await record.request(
        join(recovery.root, 'bridge', 'coral-backend.cjs'),
        buildSetId(recovery.root),
        {
          instanceId: 'probe',
          pid: child.pid,
          incarnation: childIncarnation,
          version: '0.10.14',
          bundleHash: oldManifest.bundleHash,
          flavor: 'prod',
        },
      );
      writeFileSync(join(runDir, 'coordinator.json'), JSON.stringify({ pid: child.pid, bootToken: 'probe' }));
      await new Promise<void>((resolve) =>
        server.listen(socketPathForRunDir(runDir, 'prod', { platform: process.platform }), resolve),
      );
      try {
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
        supervisor = spawn(process.execPath, [harness, join(recovery.root, 'bridge', 'coral-backend.cjs')], {
          env: {
            ...process.env,
            HOME: home,
            TMPDIR: home,
            CORAL_SENTINEL_RUN_DIR: runDir,
          },
          stdio: ['ignore', 'ignore', 'pipe'],
        });
        let supervisorErrors = '';
        supervisor.stderr?.on('data', (chunk: Buffer) => {
          supervisorErrors += chunk.toString('utf8');
        });
        const inheritedPid = child.pid;
        if (inheritedPid === undefined) throw new Error('Inherited child has no PID');
        await waitForCondition(() => probeProcessIncarnation(inheritedPid) === null, 5_000);
        try {
          await waitForCondition(
            () =>
              record.read().launch?.phase === 'serving' &&
              record.read().launch?.buildSetId === buildSetId(recovery.root),
            20_000,
          );
        } catch (error: unknown) {
          throw new Error(
            `Recovery stalled: ${JSON.stringify(record.read())}; supervisor exit ${supervisor.exitCode}`,
            {
              cause: error,
            },
          );
        }
        recoveredPid = record.read().launch?.child?.pid;
        expect(supervisor.exitCode).toBeNull();
        expect(probeProcessIncarnation(otherChild.pid)).toBeNull();
        try {
          await waitForCondition(
            () => record.read().requests.find((entry) => entry.id === request.id)?.status === 'completed',
            5_000,
          );
        } catch (error: unknown) {
          throw new Error(
            `Recovered request not completed: ${JSON.stringify(record.read())}; stderr=${supervisorErrors}`,
            { cause: error },
          );
        }
      } finally {
        if (server.listening) server.close();
        if (supervisor !== null && supervisor.exitCode === null) supervisor.kill('SIGKILL');
        child.kill('SIGKILL');
        otherChild.kill('SIGKILL');
        if (recoveredPid !== undefined) {
          try {
            process.kill(recoveredPid, 'SIGKILL');
          } catch {
            // Recovery may already have exited.
          }
        }
        record.close();
        for (const root of roots.reverse()) rmSync(root, { recursive: true, force: true });
      }
    },
    35_000,
  );
  it.runIf(process.platform === 'linux')(
    'escalates a wedged inherited child to KILL before recovery',
    async () => {
      const roots: string[] = [];
      const home = mkdtempSync(join(tmpdir(), 'coral-inherited-wedged-serving-'));
      roots.push(home);
      const original = createPluginFixture(roots, { flavor: 'prod', version: '0.10.14', accepts: 'bundled' });
      const recovery = createPluginFixture(roots, { flavor: 'prod', version: '0.10.16', accepts: 'bundled' });
      const runDir = coordinatorPaths('prod', { baseDir: join(home, '.coral') }).runDir;
      const fixture = join(home, 'inherited-child.mjs');
      await build({
        entryPoints: [fileURLToPath(new URL('./fixtures/inherited-admission-child.ts', import.meta.url))],
        outfile: fixture,
        bundle: true,
        platform: 'node',
        target: 'node22',
        format: 'esm',
        external: ['node:*'],
      });
      const termPath = join(home, 'sigterm-at');
      const stalled = spawn(
        process.execPath,
        [
          fixture,
          runDir,
          admittedBuild(original.root),
          'startup',
          String(process.pid),
          'dead-parent',
          '30000',
          termPath,
        ],
        { stdio: 'ignore' },
      );
      const record = new SupervisorEvidence(runDir);
      let supervisor: ReturnType<typeof spawn> | null = null;
      try {
        if (stalled.pid === undefined) throw new Error('Fixture child has no PID');
        let incarnation = probeProcessIncarnation(stalled.pid);
        await waitForCondition(() => (incarnation = probeProcessIncarnation(stalled.pid!)) !== null, 5_000);
        if (incarnation === null) throw new Error('Fixture child has no incarnation');
        await waitForCondition(() => record.read().launch?.child.pid === stalled.pid, 5_000);
        const oldManifest = JSON.parse(
          readFileSync(join(original.root, 'bridge', CURRENT_STRICT_BUNDLE_MANIFEST_FILE), 'utf8'),
        ) as { bundleHash: string };
        await record.request(join(recovery.root, 'bridge', 'coral-backend.cjs'), buildSetId(recovery.root), {
          instanceId: 'wedged',
          pid: stalled.pid,
          incarnation,
          version: '0.10.14',
          bundleHash: oldManifest.bundleHash,
          flavor: 'prod',
        });
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
        supervisor = spawn(process.execPath, [harness, join(recovery.root, 'bridge', 'coral-backend.cjs')], {
          env: { ...process.env, HOME: home, TMPDIR: home, CORAL_SENTINEL_RUN_DIR: runDir },
          stdio: 'ignore',
        });
        await waitForCondition(() => existsSync(termPath), 5_000);
        const termAt = Number(readFileSync(termPath, 'utf8'));
        try {
          await waitForCondition(
            () =>
              record.read().launch?.phase === 'serving' &&
              record.read().launch?.buildSetId === buildSetId(recovery.root),
            10_000,
          );
        } catch (error: unknown) {
          throw new Error(`Inherited child recovery did not serve: ${JSON.stringify(record.read())}`, { cause: error });
        }
        await waitForCondition(() => stalled.exitCode !== null || stalled.signalCode !== null, 5_000);
        expect(stalled.signalCode).toBe('SIGKILL');
        expect(Date.now() - termAt).toBeGreaterThanOrEqual(80);
        expect(probeProcessIncarnation(stalled.pid)).not.toBe(incarnation);
      } finally {
        const currentPid = record.read().launch?.child?.pid;
        record.close();
        if (supervisor !== null && supervisor.exitCode === null) supervisor.kill('SIGKILL');
        if (stalled.exitCode === null) stalled.kill('SIGKILL');
        if (currentPid !== undefined && currentPid !== stalled.pid) {
          try {
            process.kill(currentPid, 'SIGKILL');
          } catch {
            // The recovery child may have exited.
          }
        }
        const stoppedSupervisor = supervisor;
        if (stoppedSupervisor !== null)
          await waitForCondition(
            () => stoppedSupervisor.exitCode !== null || stoppedSupervisor.signalCode !== null,
            5_000,
          );
        await waitForCondition(() => stalled.exitCode !== null || stalled.signalCode !== null, 5_000);
        await waitForCondition(() => {
          try {
            for (const root of roots.reverse()) rmSync(root, { recursive: true, force: true });
            return true;
          } catch (error: unknown) {
            if (error instanceof Error && 'code' in error && error.code === 'ENOTEMPTY') return false;
            throw error;
          }
        }, 5_000);
      }
    },
    20_000,
  );
  it('starts the newest installed eligible build ahead of an older bootstrap request', async () => {
    const roots: string[] = [];
    const home = mkdtempSync(join(tmpdir(), 'coral-installed-build-order-'));
    roots.push(home);
    const older = createPluginFixture(roots, { flavor: 'prod', version: '0.10.14' });
    const newer = createPluginFixture(roots, { flavor: 'prod', version: '0.10.16' });
    const registry = join(home, 'installed.json');
    const helloMarker = join(home, 'paused-after-hello');
    writeFileSync(registry, JSON.stringify({ plugins: { 'coral@fixture': [{ installPath: newer.root }] } }));
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
    const supervisor = spawn(process.execPath, [harness, join(older.root, 'bridge', 'coral-backend.cjs')], {
      env: {
        ...process.env,
        HOME: home,
        TMPDIR: home,
        CORAL_SENTINEL_RUN_DIR: runDir,
        CORAL_PLUGIN_REGISTRY: registry,
        CORAL_FIXTURE_REAL_BACKEND: '1',
        CORAL_FIXTURE_PAUSE_AFTER_HELLO: helloMarker,
      },
      stdio: 'ignore',
    });
    const record = new SupervisorEvidence(runDir);
    let pausedPid: number | undefined;
    try {
      await waitForCondition(() => existsSync(helloMarker), 5_000);
      pausedPid = Number(readFileSync(helloMarker, 'utf8'));
      await new Promise((resolve) => setTimeout(resolve, 700));
      process.kill(pausedPid, 'SIGCONT');
      const memory = record.memory();
      expect(memory?.launch?.child?.pid).toBe(pausedPid);
      expect(memory?.launch?.terminationAt).toBeUndefined();
      await waitForCondition(() => record.read().launch?.phase === 'serving', 20_000);
      expect(record.read().launch?.buildSetId).toBe(buildSetId(newer.root));
    } finally {
      const childPid = record.read().launch?.child?.pid;
      record.close();
      if (supervisor.exitCode === null) supervisor.kill('SIGKILL');
      for (const pid of new Set([childPid, pausedPid])) {
        if (pid === undefined) continue;
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // The child may have exited.
        }
      }
      for (const root of roots.reverse()) rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
  it('completes a deferred request under the new supervisor', async () => {
    const roots: string[] = [];
    const home = mkdtempSync(join(tmpdir(), 'coral-owner-epoch-request-'));
    roots.push(home);
    const plugin = createPluginFixture(roots, { flavor: 'prod' });
    const executable = join(plugin.root, 'bridge', 'coral-backend.cjs');
    const buildSetId = (
      JSON.parse(readFileSync(join(plugin.root, 'bridge', CURRENT_STRICT_BUNDLE_MANIFEST_FILE), 'utf8')) as {
        buildSetId: string;
      }
    ).buildSetId;
    const runDir = coordinatorPaths('prod', { baseDir: join(home, '.coral') }).runDir;
    const record = new SupervisorEvidence(runDir);
    const request = await record.request(executable, buildSetId);
    const pending = readUpgradeIntent(runDir);
    if (pending.kind !== 'readable') throw new Error('Requested upgrade intent is unavailable');
    expect(
      await compareAndSwapUpgradeIntent(runDir, pending.intent.revision, {
        ...pending.intent,
        disposition: 'deferred',
        retryCondition: { kind: 'incumbent-retirement', evidence: 'earlier supervisor exited' },
      }),
    ).toMatchObject({ kind: 'written' });
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
    const supervisor = spawn(process.execPath, [harness, executable], {
      env: {
        ...process.env,
        HOME: home,
        TMPDIR: home,
        CORAL_SENTINEL_RUN_DIR: runDir,
        CORAL_FIXTURE_REAL_BACKEND: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let supervisorOutput = '';
    supervisor.stdout?.on('data', (chunk: Buffer) => {
      supervisorOutput += chunk.toString();
    });
    supervisor.stderr?.on('data', (chunk: Buffer) => {
      supervisorOutput += chunk.toString();
    });
    try {
      await waitForCondition(() => record.read().owner?.process.pid === supervisor.pid, 10_000);
      try {
        await waitForCondition(() => record.read().launch?.phase === 'serving', 20_000);
      } catch (error: unknown) {
        throw new Error(`Deferred request did not serve: ${JSON.stringify(record.read())}; ${supervisorOutput}`, {
          cause: error,
        });
      }
      try {
        await waitForCondition(
          () => record.read().requests.find((entry) => entry.id === request.id)?.status === 'completed',
          5_000,
        );
      } catch (error: unknown) {
        throw new Error(`Deferred request not completed: ${JSON.stringify(record.read())}; ${supervisorOutput}`, {
          cause: error,
        });
      }
      expect(record.read().requests.find((entry) => entry.id === request.id)).toMatchObject({
        status: 'completed',
      });
      expect(record.read().intent?.completionReceipt?.kind).toBe('serving');
      expect(record.read().launch?.parent?.pid).toBe(supervisor.pid);
      const childPid = record.read().launch?.child?.pid;
      if (childPid === undefined) throw new Error('Serving child has no PID');
      process.kill(childPid, 'SIGINT');
      await waitForCondition(() => record.read().owner === null, 15_000);
      await waitForCondition(() => supervisor.exitCode !== null, 5_000);
    } finally {
      const childPid = record.read().launch?.child?.pid;
      record.close();
      if (supervisor.exitCode === null) supervisor.kill('SIGKILL');
      if (childPid !== undefined) {
        try {
          process.kill(childPid, 'SIGKILL');
        } catch {
          // The child may have exited.
        }
      }
      for (const root of roots.reverse()) rmSync(root, { recursive: true, force: true });
    }
  }, 35_000);
  it.each([
    { stall: 'an admitted child without hello', phase: 'before-hello', observed: 'admitted', refuseKill: false },
    {
      stall: 'a child that never claims admission',
      phase: 'before-admission',
      observed: 'reserved',
      refuseKill: false,
    },
    { stall: 'a refused SIGKILL', phase: 'before-hello', observed: 'admitted', refuseKill: true },
  ] as const)(
    'terminates $stall and serves from a fallback',
    async ({ phase, observed, refuseKill }) => {
      const roots: string[] = [];
      const home = mkdtempSync(join(tmpdir(), 'coral-no-first-hello-'));
      roots.push(home);
      const installed = createPluginFixture(roots, { flavor: 'prod', version: '0.10.16', backend: 'admission-freeze' });
      const fallback = createPluginFixture(roots, { flavor: 'prod', version: '0.10.13' });
      const fallbackBuildSetId = (
        JSON.parse(readFileSync(join(fallback.root, 'bridge', CURRENT_STRICT_BUNDLE_MANIFEST_FILE), 'utf8')) as {
          buildSetId: string;
        }
      ).buildSetId;
      const installedBuildSetId = (
        JSON.parse(readFileSync(join(installed.root, 'bridge', CURRENT_STRICT_BUNDLE_MANIFEST_FILE), 'utf8')) as {
          buildSetId: string;
        }
      ).buildSetId;
      const retained = join(home, '.coral', 'gen2', 'builds', fallbackBuildSetId);
      mkdirSync(join(retained, '..'), { recursive: true });
      renameSync(fallback.root, retained);
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
      const registry = join(home, 'installed.json');
      writeFileSync(registry, JSON.stringify({ plugins: { 'coral@fixture': [{ installPath: installed.root }] } }));
      const record = new SupervisorEvidence(runDir);
      await record.request(join(installed.root, 'bridge', 'coral-backend.cjs'), installedBuildSetId);
      const childPidPath = join(home, 'first-child.pid');
      const supervisor = spawn(process.execPath, [harness, join(retained, 'bridge', 'coral-backend.cjs')], {
        env: {
          ...process.env,
          HOME: home,
          TMPDIR: home,
          CORAL_SENTINEL_RUN_DIR: runDir,
          CORAL_PLUGIN_REGISTRY: registry,
          CORAL_FIXTURE_STARTUP_BUDGET_MS: '1500',
          CORAL_FIXTURE_FREEZE_PHASE: phase,
          CORAL_FIXTURE_IGNORE_SIGTERM: refuseKill ? '1' : '0',
          CORAL_FIXTURE_REFUSE_KILL_ONCE: refuseKill ? '1' : '0',
          CORAL_FIXTURE_CHILD_PID_PATH: childPidPath,
        },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let supervisorErrors = '';
      supervisor.stderr?.on('data', (chunk: Buffer) => {
        supervisorErrors += chunk.toString('utf8');
      });
      let stalledPid: number | undefined;
      try {
        if (observed === 'reserved') {
          await waitForCondition(() => existsSync(childPidPath), 10_000);
          stalledPid = Number(readFileSync(childPidPath, 'utf8'));
          expect(probeProcessIncarnation(stalledPid)).not.toBeNull();
          expect(listLaunchAdmissions(runDir)).toEqual([]);
        } else {
          await waitForCondition(() => {
            const launch = record.read().launch;
            return launch?.phase === observed && launch.buildSetId === installedBuildSetId;
          }, 10_000);
          stalledPid = record.read().launch?.child?.pid;
        }
        if (refuseKill) {
          await waitForCondition(
            () => record.read().signalHolds?.some((hold) => hold.launchId === record.read().launch?.id) === true,
            8_000,
          );
        }
        try {
          await waitForCondition(() => {
            const launch = record.read().launch;
            return launch?.phase === 'serving' && launch.buildSetId === fallbackBuildSetId;
          }, 15_000);
        } catch (error: unknown) {
          throw new Error(
            `Fallback did not serve: ${JSON.stringify(record.read())}; supervisor=${supervisor.pid}/${supervisor.exitCode}/${supervisor.signalCode}; stalled=${stalledPid}/${stalledPid === undefined ? 'none' : probeProcessIncarnation(stalledPid)}; stderr=${supervisorErrors}`,
            { cause: error },
          );
        }
        expect(record.read().launch?.child?.pid).not.toBe(stalledPid);
        if (refuseKill) expect(record.read().signalHolds).toEqual([]);
      } finally {
        const currentPid = record.read().launch?.child?.pid;
        record.close();
        if (supervisor.exitCode === null) supervisor.kill('SIGKILL');
        for (const pid of [stalledPid, currentPid]) {
          if (pid === undefined) continue;
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            // The process may already have exited.
          }
        }
        for (const root of roots.reverse()) rmSync(root, { recursive: true, force: true });
      }
    },
    30_000,
  );

  it('escalates an explicit attempt retirement after a refused SIGTERM', async () => {
    const roots: string[] = [];
    const home = mkdtempSync(join(tmpdir(), 'coral-explicit-attempt-retirement-'));
    roots.push(home);
    const incumbent = createPluginFixture(roots, { flavor: 'prod', version: '0.10.14' });
    const target = createPluginFixture(roots, { flavor: 'prod', version: '0.10.16', backend: 'admission-freeze' });
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
      env: {
        ...process.env,
        HOME: home,
        TMPDIR: home,
        CORAL_SENTINEL_RUN_DIR: runDir,
        CORAL_FIXTURE_IGNORE_SIGTERM: '1',
      },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    let supervisorErrors = '';
    supervisor.stderr?.on('data', (chunk: Buffer) => {
      supervisorErrors += chunk.toString('utf8');
    });
    const record = new SupervisorEvidence(runDir);
    let attemptPid: number | undefined;
    try {
      await waitForCondition(() => record.read().launch?.phase === 'serving', 20_000);
      supervisor.send({
        fixtureChildMessage: {
          kind: 'coral-supervisor-start-attempt',
          attemptId: 'explicit-retirement',
          bundleDir: join(target.root, 'bridge'),
        },
      });
      try {
        await waitForCondition(() => record.read().attempt?.child !== undefined, 5_000);
      } catch (error: unknown) {
        throw new Error(
          `Explicit attempt was not admitted: ${JSON.stringify(record.read())}; stderr=${supervisorErrors}`,
          { cause: error },
        );
      }
      attemptPid = record.read().attempt?.child?.pid;
      supervisor.send({
        fixtureChildMessage: { kind: 'coral-supervisor-retire-attempt', attemptId: 'explicit-retirement' },
      });
      await waitForCondition(() => record.read().attempt?.phase === 'exited', 5_000);
      expect(record.read().signalHolds).toEqual([]);
    } finally {
      const incumbentPid = record.read().launch?.child?.pid;
      record.close();
      if (supervisor.exitCode === null) supervisor.kill('SIGKILL');
      for (const pid of [attemptPid, incumbentPid]) {
        if (pid === undefined) continue;
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          continue;
        }
      }
      for (const root of roots.reverse()) rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('dispatches a newer request after the serving build installation is removed', async () => {
    const roots: string[] = [];
    const home = mkdtempSync(join(tmpdir(), 'coral-removed-serving-root-'));
    roots.push(home);
    const original = createPluginFixture(roots, { flavor: 'prod', version: '0.10.14' });
    const target = createPluginFixture(roots, { flavor: 'prod', version: '0.10.16' });
    const originalBuildSetId = (
      JSON.parse(readFileSync(join(original.root, 'bridge', CURRENT_STRICT_BUNDLE_MANIFEST_FILE), 'utf8')) as {
        buildSetId: string;
      }
    ).buildSetId;
    const targetBuildSetId = (
      JSON.parse(readFileSync(join(target.root, 'bridge', CURRENT_STRICT_BUNDLE_MANIFEST_FILE), 'utf8')) as {
        buildSetId: string;
      }
    ).buildSetId;
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
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let supervisorErrors = '';
    supervisor.stderr?.on('data', (chunk: Buffer) => {
      supervisorErrors += chunk.toString('utf8');
    });
    const record = new SupervisorEvidence(runDir);
    let firstPid: number | undefined;
    try {
      await waitForCondition(() => record.read().launch?.phase === 'serving', 20_000);
      firstPid = record.read().launch?.child?.pid;
      await waitForCondition(
        () => existsSync(join(home, '.coral', 'gen2', 'builds', originalBuildSetId, 'bridge', 'coral-backend.cjs')),
        10_000,
      );
      rmSync(original.root, { recursive: true, force: true });
      const request = await record.request(join(target.root, 'bridge', 'coral-backend.cjs'), targetBuildSetId);
      try {
        await waitForCondition(
          () => record.read().requests.find((entry) => entry.id === request.id)?.status === 'completed',
          20_000,
        );
      } catch (error: unknown) {
        throw new Error(
          `Removed-root request did not complete: ${JSON.stringify(record.read())}\n${supervisorErrors}`,
          {
            cause: error,
          },
        );
      }
      await waitForCondition(() => {
        const launch = record.read().launch;
        return launch?.phase === 'serving' && launch.buildSetId === targetBuildSetId;
      }, 15_000);
      expect(record.read().launch).toMatchObject({ phase: 'serving', buildSetId: targetBuildSetId });
    } finally {
      const currentPid = record.read().launch?.child?.pid;
      record.close();
      if (supervisor.exitCode === null) supervisor.kill('SIGKILL');
      for (const pid of [firstPid, currentPid]) {
        if (pid === undefined) continue;
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // The process may already have exited.
        }
      }
      for (const root of roots.reverse()) rmSync(root, { recursive: true, force: true });
    }
  }, 40_000);

  it('replaces its supervisor from the retained build after installation removal', async () => {
    const roots: string[] = [];
    const home = mkdtempSync(join(tmpdir(), 'coral-removed-supervisor-root-'));
    roots.push(home);
    const plugin = createPluginFixture(roots, { flavor: 'prod' });
    const buildSetId = (
      JSON.parse(readFileSync(join(plugin.root, 'bridge', CURRENT_STRICT_BUNDLE_MANIFEST_FILE), 'utf8')) as {
        buildSetId: string;
      }
    ).buildSetId;
    const retained = join(home, '.coral', 'gen2', 'builds', buildSetId);
    const heldRetained = join(home, 'held-retained-build');
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
    const supervisor = spawn(process.execPath, [harness, join(plugin.root, 'bridge', 'coral-backend.cjs')], {
      env: { ...process.env, HOME: home, TMPDIR: home, CORAL_SENTINEL_RUN_DIR: runDir },
      stdio: 'ignore',
    });
    const record = new SupervisorEvidence(runDir);
    let childPid: number | undefined;
    let replacementPid: number | undefined;
    try {
      await waitForCondition(() => record.read().launch?.phase === 'serving', 20_000);
      childPid = record.read().launch?.child?.pid;
      await waitForCondition(() => existsSync(join(retained, 'bridge', 'coral-sentinel.cjs')), 10_000);
      rmSync(plugin.root, { recursive: true, force: true });
      renameSync(retained, heldRetained);
      supervisor.kill('SIGKILL');
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      expect(record.read().owner).toBeNull();
      expect(record.read().launch).toMatchObject({ phase: 'serving', child: { pid: childPid } });
      renameSync(heldRetained, retained);
      replacementPid = await waitForReplacementLockHolder(record, supervisor.pid, 15_000);
      if (replacementPid === undefined) throw new Error('Replacement owner has no PID');
      const command = readFileSync(`/proc/${replacementPid}/cmdline`, 'utf8');
      expect(command).toContain(join(retained, 'bridge', 'coral-sentinel.cjs'));
      expect(record.read().launch).toMatchObject({ phase: 'serving', child: { pid: childPid } });
    } finally {
      if (existsSync(heldRetained)) renameSync(heldRetained, retained);
      record.close();
      if (supervisor.exitCode === null) supervisor.kill('SIGKILL');
      for (const pid of [childPid, replacementPid]) {
        if (pid === undefined) continue;
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // The process may already have exited.
        }
      }
      for (const root of roots.reverse()) rmSync(root, { recursive: true, force: true });
    }
  }, 40_000);

  it('keeps the launch lock while it parents the child and serves a pending request', async () => {
    const roots: string[] = [];
    const home = mkdtempSync(join(tmpdir(), 'coral-supervisor-lost-renewal-'));
    roots.push(home);
    const original = createPluginFixture(roots, { flavor: 'prod', version: '0.10.14' });
    const target = createPluginFixture(roots, { flavor: 'prod', version: '0.10.16' });
    const targetBuildSetId = (
      JSON.parse(readFileSync(join(target.root, 'bridge', CURRENT_STRICT_BUNDLE_MANIFEST_FILE), 'utf8')) as {
        buildSetId: string;
      }
    ).buildSetId;
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
      },
      stdio: 'ignore',
    });
    const record = new SupervisorEvidence(runDir);
    let childPid: number | undefined;
    let successorPid: number | undefined;
    let claimant: ReturnType<typeof spawn> | null = null;
    try {
      await waitForCondition(() => record.read().launch?.phase === 'serving', 20_000);
      childPid = record.read().launch?.child?.pid;
      if (childPid === undefined) throw new Error('Serving child has no PID');
      claimant = spawn(process.execPath, [harness, join(target.root, 'bridge', 'coral-backend.cjs')], {
        env: { ...process.env, HOME: home, TMPDIR: home, CORAL_SENTINEL_RUN_DIR: runDir },
        stdio: 'ignore',
      });
      await waitForCondition(
        () => record.read().requests.some((entry) => entry.buildSetId === targetBuildSetId),
        5_000,
      );
      expect(claimant.exitCode).toBeNull();
      expect(record.lockHolder()?.pid).toBe(supervisor.pid);
      await waitForCondition(() => {
        const launch = record.read().launch;
        return launch?.phase === 'serving' && launch.buildSetId === targetBuildSetId;
      }, 20_000);
      successorPid = record.read().owner?.process.pid;
      expect(successorPid).toBe(supervisor.pid);
      expect(record.lockHolder()?.pid).toBe(supervisor.pid);
      expect(record.read().owner?.mode).toBe('supervised');
      await waitForCondition(() => claimant?.exitCode !== null, 15_000);
      expect(claimant.exitCode).toBe(0);
    } finally {
      const currentChildPid = record.read().launch?.child?.pid;
      record.close();
      if (supervisor.exitCode === null) supervisor.kill('SIGKILL');
      if (claimant !== null && claimant.exitCode === null) claimant.kill('SIGKILL');
      for (const pid of [childPid, currentChildPid, successorPid]) {
        if (pid === undefined) continue;
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // The process may already have exited.
        }
      }
      for (const root of roots.reverse()) rmSync(root, { recursive: true, force: true });
    }
  }, 40_000);

  it('serves after moving aside a malformed launch lock nobody can hold', async () => {
    const roots: string[] = [];
    const home = mkdtempSync(join(tmpdir(), 'coral-supervisor-malformed-lock-'));
    roots.push(home);
    const original = createPluginFixture(roots, { flavor: 'prod', version: '0.10.14' });
    const runDir = coordinatorPaths('prod', { baseDir: join(home, '.coral') }).runDir;
    mkdirSync(runDir, { recursive: true, mode: 0o700 });
    writeFileSync(supervisorLockPath(runDir), 'garbage bytes that are not a sqlite database header at all');
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
      },
      stdio: 'ignore',
    });
    const record = new SupervisorEvidence(runDir);
    let childPid: number | undefined;
    try {
      await waitForCondition(() => record.read().launch?.phase === 'serving', 20_000);
      childPid = record.read().launch?.child?.pid;
      expect(record.lockHolder()?.pid).toBe(supervisor.pid);
      expect(readdirSync(runDir).some((name) => name.startsWith('namespace-supervisor.v1.lock.malformed-'))).toBe(true);
    } finally {
      record.close();
      if (supervisor.exitCode === null) supervisor.kill('SIGKILL');
      if (childPid !== undefined) {
        try {
          process.kill(childPid, 'SIGKILL');
        } catch {
          // The process may already have exited.
        }
      }
      for (const root of roots.reverse()) rmSync(root, { recursive: true, force: true });
    }
  }, 40_000);

  it('records no upgrade request for a bound socket until its coordinator publishes an identity', async () => {
    const roots: string[] = [];
    const home = mkdtempSync(join(tmpdir(), 'coral-supervisor-unidentified-binder-'));
    roots.push(home);
    const target = createPluginFixture(roots, { flavor: 'prod', version: '0.10.16' });
    const runDir = coordinatorPaths('prod', { baseDir: join(home, '.coral') }).runDir;
    mkdirSync(runDir, { recursive: true, mode: 0o700 });
    const binder = createServer();
    await new Promise<void>((resolve) =>
      binder.listen(socketPathForRunDir(runDir, 'prod', { platform: process.platform }), resolve),
    );
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
    const supervisor = spawn(process.execPath, [harness, join(target.root, 'bridge', 'coral-backend.cjs')], {
      env: { ...process.env, HOME: home, TMPDIR: home, CORAL_SENTINEL_RUN_DIR: runDir },
      stdio: 'ignore',
    });
    try {
      await waitForCondition(() => new SupervisorEvidence(runDir).lockHolder()?.pid === supervisor.pid, 10_000);
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(readUpgradeIntent(runDir).kind).toBe('absent');

      const incarnation = probeProcessIncarnation(process.pid);
      if (incarnation === null) throw new Error('Test process incarnation is unavailable');
      writeFileSync(
        join(runDir, 'coordinator.json'),
        JSON.stringify({
          pid: process.pid,
          incarnation,
          instanceId: 'identified-binder',
          version: '0.10.14',
          bundleHash: 'binder-bundle',
          flavor: 'prod',
          port: 1,
          socketPath: socketPathForRunDir(runDir, 'prod', { platform: process.platform }),
          namespace: 'binder',
          startedAt: Date.now(),
          token: 'binder-token',
          bootToken: 'binder-boot-token',
        }),
      );

      await waitForCondition(() => {
        const observed = readUpgradeIntent(runDir);
        return observed.kind === 'readable' && observed.intent.incumbent.instanceId === 'identified-binder';
      }, 10_000);
      const observed = readUpgradeIntent(runDir);
      expect(observed).toMatchObject({
        kind: 'readable',
        intent: {
          incumbent: { pid: process.pid, incarnation, version: '0.10.14', bundleHash: 'binder-bundle' },
          target: { build: { version: '0.10.16' } },
          legacyRetirement: true,
        },
      });
    } finally {
      if (supervisor.exitCode === null) supervisor.kill('SIGKILL');
      await new Promise<void>((resolve) => binder.close(() => resolve()));
      for (const root of roots.reverse()) rmSync(root, { recursive: true, force: true });
    }
  }, 40_000);

  it('does not let a claimant steal the lock from a stopped supervisor', async () => {
    const roots: string[] = [];
    const home = mkdtempSync(join(tmpdir(), 'coral-supervisor-claimant-'));
    roots.push(home);
    const original = createPluginFixture(roots, { flavor: 'prod', version: '0.10.14' });
    const target = createPluginFixture(roots, { flavor: 'prod', version: '0.10.16' });
    const targetBuildSetId = (
      JSON.parse(readFileSync(join(target.root, 'bridge', CURRENT_STRICT_BUNDLE_MANIFEST_FILE), 'utf8')) as {
        buildSetId: string;
      }
    ).buildSetId;
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
    const env = { ...process.env, HOME: home, TMPDIR: home, CORAL_SENTINEL_RUN_DIR: runDir };
    const incumbent = spawn(process.execPath, [harness, join(original.root, 'bridge', 'coral-backend.cjs')], {
      env,
      stdio: 'ignore',
    });
    const record = new SupervisorEvidence(runDir);
    let claimant: ReturnType<typeof spawn> | null = null;
    let childPid: number | undefined;
    try {
      await waitForCondition(() => record.read().launch?.phase === 'serving', 20_000);
      childPid = record.read().launch?.child?.pid;
      if (childPid === undefined) throw new Error('Serving child has no PID');
      incumbent.kill('SIGSTOP');
      claimant = spawn(process.execPath, [harness, join(target.root, 'bridge', 'coral-backend.cjs')], {
        env,
        stdio: 'ignore',
      });
      await waitForCondition(
        () => record.read().requests.some((entry) => entry.buildSetId === targetBuildSetId),
        5_000,
      );
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      expect(claimant.exitCode).toBeNull();
      expect(record.lockHolder()?.pid).toBe(incumbent.pid);
      incumbent.kill('SIGCONT');
      await waitForCondition(() => {
        const launch = record.read().launch;
        return launch?.phase === 'serving' && launch.buildSetId === targetBuildSetId;
      }, 20_000);
      await waitForCondition(
        () => record.read().requests.find((entry) => entry.buildSetId === targetBuildSetId)?.status === 'completed',
        5_000,
      );
      expect(record.lockHolder()?.pid).toBe(incumbent.pid);
      await waitForCondition(() => claimant?.exitCode !== null, 15_000);
      expect(claimant.exitCode).toBe(0);
    } finally {
      const currentChildPid = record.read().launch?.child?.pid;
      record.close();
      incumbent.kill('SIGCONT');
      if (incumbent.exitCode === null) incumbent.kill('SIGKILL');
      if (claimant !== null && claimant.exitCode === null) claimant.kill('SIGKILL');
      for (const pid of [childPid, currentChildPid]) {
        if (pid === undefined) continue;
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // The child may already have exited.
        }
      }
      for (const root of roots.reverse()) rmSync(root, { recursive: true, force: true });
    }
  }, 40_000);

  it('repairs supervision into the same build without an upgrade request', async () => {
    const roots: string[] = [];
    const home = mkdtempSync(join(tmpdir(), 'coral-supervisor-loss-'));
    roots.push(home);
    const plugin = createPluginFixture(roots, { flavor: 'prod' });
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
    const supervisor = spawn(process.execPath, [harness, join(plugin.root, 'bridge', 'coral-backend.cjs')], {
      env: { ...process.env, HOME: home, TMPDIR: home, CORAL_SENTINEL_RUN_DIR: runDir },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let coordinatorErrors = '';
    supervisor.stderr?.on('data', (chunk: Buffer) => {
      coordinatorErrors += chunk.toString('utf8');
    });
    const record = new SupervisorEvidence(runDir);
    let childPid: number | undefined;
    let replacementPid: number | undefined;
    let repairedPid: number | undefined;
    try {
      await waitForCondition(() => record.read().launch?.phase === 'serving', 20_000);
      childPid = record.read().launch?.child?.pid;
      if (childPid === undefined) throw new Error('Serving coordinator has no PID');
      const lostAt = Date.now();
      supervisor.kill('SIGKILL');
      replacementPid = await waitForReplacementLockHolder(record, supervisor.pid, 10_000);
      expect(namespaceLockHolders(runDir)).toEqual([replacementPid]);
      expect(record.read().launch).toMatchObject({ phase: 'serving', child: { pid: childPid } });
      expect(() => process.kill(childPid!, 0)).not.toThrow();
      try {
        await waitForCondition(
          () =>
            record.read().launch?.phase === 'serving' &&
            record.read().launch?.child?.pid !== childPid &&
            record.read().owner?.mode === 'supervised',
          25_000,
        );
      } catch (error: unknown) {
        throw new Error(
          `Same-build repair did not serve: ${JSON.stringify(record.read())}; intent=${JSON.stringify(readUpgradeIntent(runDir))}; stderr=${coordinatorErrors
            .split('\n')
            .filter((line) => /repair|supervisor/i.test(line))
            .slice(-10)
            .join('\n')}`,
          { cause: error },
        );
      }
      repairedPid = record.read().launch?.child?.pid;
      expect(
        memoryObservations(join(home, 'supervisor-memory.jsonl')).some(
          (event) =>
            event.pid === replacementPid &&
            [event.state?.launch, event.state?.attempt].some(
              (slot) => slot?.child?.pid === childPid && (slot?.observedHealthyAt ?? 0) >= lostAt,
            ),
        ),
      ).toBe(true);
      expect(Date.now() - lostAt).toBeLessThan(35_000);
      expect(record.read().launch?.parent).toEqual(record.read().owner?.process);
      if (repairedPid === undefined) throw new Error('Repaired coordinator has no PID');
      process.kill(repairedPid, 'SIGINT');
      try {
        await waitForCondition(() => record.read().owner === null, 20_000);
      } catch (error: unknown) {
        throw new Error(`Replacement did not retire: ${JSON.stringify(record.read())}`, { cause: error });
      }
      expect(record.read().launch?.phase).toBe('exited');
    } finally {
      record.close();
      if (supervisor.exitCode === null) supervisor.kill('SIGKILL');
      for (const pid of [childPid, replacementPid, repairedPid]) {
        if (pid === undefined) continue;
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // The process may already have exited.
        }
      }
      for (const root of roots.reverse()) rmSync(root, { recursive: true, force: true });
    }
  }, 40_000);

  it('repairs supervision before a format-blocked upgrade while its job stays live', async () => {
    const roots: string[] = [];
    const home = mkdtempSync(join(tmpdir(), 'coral-blocked-supervision-repair-'));
    roots.push(home);
    const incumbent = createPluginFixture(roots, { flavor: 'prod', version: '0.10.14', accepts: 'bundled' });
    const upgrade = createPluginFixture(roots, { flavor: 'prod', version: '0.10.15', accepts: 'bundled' });
    const bridge = join(upgrade.root, 'bridge');
    const strictPath = join(bridge, CURRENT_STRICT_BUNDLE_MANIFEST_FILE);
    const strict = JSON.parse(readFileSync(strictPath, 'utf8')) as {
      version: string;
      buildSetId: string;
      flavor: string;
      storeFormatFingerprint: string;
      bundleHash: string;
      cliBundleHash: string;
      claudeAppserverBundleHash: string;
      durableWrapperBundleHash: string;
    };
    const oldFingerprint = strict.storeFormatFingerprint;
    const backendPath = join(bridge, 'coral-backend.cjs');
    const buildChangingBackend = async (): Promise<void> => {
      await build({
        entryPoints: [join(process.cwd(), 'tests', 'fixtures', 'durable-succession-provider.ts')],
        outfile: backendPath,
        bundle: true,
        platform: 'node',
        target: 'node22',
        format: 'cjs',
        external: ['node:*', '@lydell/node-pty'],
        loader: { '.sql': 'text' },
        minify: true,
        plugins: [
          {
            name: 'schema-changing-fixture',
            setup(builder: PluginBuild) {
              builder.onLoad({ filter: /schema\.sql$/ }, (args) => ({
                contents: `${readFileSync(args.path, 'utf8')}\nCREATE TABLE repair_test_generation (id INTEGER PRIMARY KEY);\n`,
                loader: 'text',
              }));
            },
          },
        ],
        banner: {
          js:
            `var __CORAL_BUILD_IDENTITY__=${JSON.stringify({
              version: strict.version,
              buildSetId: strict.buildSetId,
              flavor: strict.flavor,
              storeFormatFingerprint: strict.storeFormatFingerprint,
            })};` +
            'var __PLUGIN_ROOT__=require("path").resolve(__dirname,"..");' +
            'var __BUNDLE_DIR__=__dirname;' +
            'var __importMetaUrl=require("url").pathToFileURL(__filename).href;',
        },
        define: {
          __VERSION__: JSON.stringify(strict.version),
          __BUILD_SET_ID__: JSON.stringify(strict.buildSetId),
          __BUILD_FLAVOR__: JSON.stringify(strict.flavor),
          __STORE_FORMAT_FINGERPRINT__: JSON.stringify(strict.storeFormatFingerprint),
          __IS_CORAL_BACKEND_MAIN__: 'true',
          'import.meta.url': '__importMetaUrl',
        },
      });
    };
    await buildChangingBackend();
    strict.storeFormatFingerprint = execFileSync(process.execPath, [backendPath, '--print-store-format-fingerprint'], {
      encoding: 'utf8',
    }).trim();
    expect(strict.storeFormatFingerprint).not.toBe(oldFingerprint);
    await buildChangingBackend();
    for (const [name, hashKey] of [
      ['coral-cli', 'cliBundleHash'],
      ['coral-claude-appserver.cjs', 'claudeAppserverBundleHash'],
      ['coral-durable-wrapper.cjs', 'durableWrapperBundleHash'],
    ] as const) {
      const path = join(bridge, name);
      writeFileSync(path, readFileSync(path, 'utf8').replaceAll(oldFingerprint, strict.storeFormatFingerprint));
      strict[hashKey] = createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 16);
    }
    strict.bundleHash = createHash('sha256').update(readFileSync(backendPath)).digest('hex').slice(0, 16);
    writeFileSync(strictPath, `${JSON.stringify(strict)}\n`);
    writeFileSync(join(bridge, 'manifest.json'), `${JSON.stringify(strict)}\n`);
    const capabilitiesPath = join(bridge, SUCCESSION_CAPABILITIES_FILE);
    const capabilities = JSON.parse(readFileSync(capabilitiesPath, 'utf8')) as { bundleHash: string };
    capabilities.bundleHash = strict.bundleHash;
    writeFileSync(capabilitiesPath, `${JSON.stringify(capabilities)}\n`);
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
    const binDir = join(home, 'bin');
    const stateDir = join(home, '.fake-codex-state');
    const projectRoot = join(home, 'project');
    mkdirSync(binDir);
    mkdirSync(stateDir);
    mkdirSync(projectRoot);
    mkdirSync(join(home, '.codex'));
    mkdirSync(join(home, '.claude'));
    writeFileSync(
      join(home, '.codex', 'auth.json'),
      JSON.stringify({ tokens: { access_token: 'fake-access-token', account_id: 'fake-account-id' } }),
    );
    const fakeCodex = join(binDir, 'codex');
    copyFileSync(join(process.cwd(), 'tests', 'fixtures', 'transfer-codex-appserver.cjs'), fakeCodex);
    chmodSync(fakeCodex, 0o755);
    const supervisor = spawn(process.execPath, [harness, join(incumbent.root, 'bridge', 'coral-backend.cjs')], {
      env: {
        ...process.env,
        HOME: home,
        TMPDIR: home,
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
        CORAL_SENTINEL_RUN_DIR: runDir,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    const record = new SupervisorEvidence(runDir);
    const pids = new Set<number>();
    let cli: ReturnType<typeof spawn> | null = null;
    let coordinatorErrors = '';
    supervisor.stderr?.on('data', (chunk: Buffer) => {
      coordinatorErrors += chunk.toString('utf8');
    });
    try {
      await waitForCondition(() => record.read().launch?.phase === 'serving', 20_000);
      const originalPid = record.read().launch?.child?.pid;
      if (originalPid === undefined) throw new Error('Serving coordinator has no PID');
      pids.add(originalPid);
      const prompt = join(projectRoot, 'prompt.txt');
      writeFileSync(prompt, 'Keep this job running through supervisor replacement.');
      cli = spawn('node', [join(incumbent.root, 'bridge', 'coral-cli'), 'codex', '-i', prompt, '--detach'], {
        cwd: projectRoot,
        env: topLevelCliEnvironment(home, { PATH: `${binDir}:${process.env.PATH ?? ''}` }),
        stdio: 'ignore',
      });
      await waitForCondition(() => cli?.exitCode !== null && existsSync(join(stateDir, 'job-running')), 30_000);
      expect(cli.exitCode).toBe(0);
      const jobPid = Number(readFileSync(join(stateDir, 'job-running'), 'utf8'));
      const jobIncarnation = probeProcessIncarnation(jobPid);
      if (jobIncarnation === null) throw new Error('Provider job process has no incarnation');
      const requested = await record.request(
        join(upgrade.root, 'bridge', 'coral-backend.cjs'),
        buildSetId(upgrade.root),
      );
      try {
        await waitForCondition(() => {
          const intent = readUpgradeIntent(runDir);
          return (
            intent.kind === 'readable' &&
            intent.intent.blockers.some((blocker) => blocker.reason.includes('blocking(format)'))
          );
        }, 20_000);
      } catch (error: unknown) {
        throw new Error(
          `Format blocker was not recorded: ${JSON.stringify(readUpgradeIntent(runDir))}; launch=${JSON.stringify(record.read())}`,
          { cause: error },
        );
      }
      supervisor.kill('SIGKILL');
      await waitForCondition(() => supervisor.exitCode !== null || supervisor.signalCode !== null, 5_000);
      try {
        await waitForCondition(() => {
          const holder = record.lockHolder();
          return holder !== null && holder.pid !== supervisor.pid;
        }, 15_000);
      } catch (error: unknown) {
        throw new Error(`Replacement not observed: ${JSON.stringify(record.read())}; stderr=${coordinatorErrors}`, {
          cause: error,
        });
      }
      const replacementPid = record.read().owner?.process.pid;
      if (replacementPid === undefined) throw new Error('Replacement supervisor has no PID');
      pids.add(replacementPid);
      try {
        await waitForCondition(
          () =>
            record.read().launch?.phase === 'serving' &&
            record.read().launch?.child?.pid !== originalPid &&
            record.read().launch?.buildSetId === buildSetId(incumbent.root) &&
            record.read().launch?.parent?.pid === replacementPid &&
            record.read().owner?.mode === 'supervised',
          25_000,
        );
      } catch (error: unknown) {
        throw new Error(
          `Same-build repair did not serve: original=${originalPid} replacement=${replacementPid} healthy=${await replacementServing(runDir, 'prod', originalPid)} discovery=${existsSync(join(runDir, 'coordinator.json')) ? readFileSync(join(runDir, 'coordinator.json'), 'utf8') : 'absent'} state=${JSON.stringify(record.read())}; intent=${JSON.stringify(readUpgradeIntent(runDir))}; stderr=${coordinatorErrors}`,
          { cause: error },
        );
      }
      const intent = readUpgradeIntent(runDir);
      expect(intent.kind).toBe('readable');
      if (intent.kind !== 'readable') throw new Error('Queued upgrade intent is unavailable');
      expect(intent.intent.target.build.buildSetId).toBe(buildSetId(upgrade.root));
      expect(intent.intent.disposition).toBe('deferred');
      expect(intent.intent.blockers.some((blocker) => blocker.reason.includes('blocking(format)'))).toBe(true);
      expect(record.read().requests.find((entry) => entry.id === requested.id)?.status).not.toBe('completed');
      expect(probeProcessIncarnation(jobPid)).toBe(jobIncarnation);
      writeFileSync(join(stateDir, 'release-job'), '');
      await waitForCondition(() => existsSync(join(stateDir, 'terminal-completed')), 20_000);
      try {
        await waitForCondition(() => {
          const state = record.read();
          const targetBuildSetId = buildSetId(upgrade.root);
          return (
            [state.launch, state.attempt].some(
              (slot) =>
                slot?.buildSetId === targetBuildSetId && (slot.phase === 'admitted' || slot.phase === 'serving'),
            ) ||
            (state.intent?.completionReceipt?.kind === 'serving' &&
              state.intent.completionReceipt.successor.build.buildSetId === targetBuildSetId)
          );
        }, 40_000);
      } catch (error: unknown) {
        throw new Error(`Queued target did not launch: ${JSON.stringify(record.read())}`, { cause: error });
      }
    } finally {
      const state = record.read();
      for (const pid of [state.owner?.process.pid, state.launch?.child?.pid, state.attempt?.child?.pid]) {
        if (pid !== undefined) pids.add(pid);
      }
      record.close();
      cli?.kill('SIGKILL');
      supervisor.kill('SIGKILL');
      for (const pid of pids) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // The process may already have exited.
        }
      }
      const jobPath = join(stateDir, 'job-running');
      if (existsSync(jobPath)) {
        try {
          process.kill(Number(readFileSync(jobPath, 'utf8')), 'SIGKILL');
        } catch {
          // The provider job may already have exited.
        }
      }
      for (const root of roots.reverse()) rmSync(root, { recursive: true, force: true });
    }
  }, 90_000);

  it('keeps ownership after an unconfirmed replacement fails and serves from a retained fallback', async () => {
    const roots: string[] = [];
    const home = mkdtempSync(join(tmpdir(), 'coral-supervisor-recovery-'));
    roots.push(home);
    const installed = createPluginFixture(roots, { flavor: 'prod', backend: 'sentinel-freeze', version: '0.10.16' });
    const original = createPluginFixture(roots, { flavor: 'prod', backend: 'sentinel-freeze', version: '0.10.13' });
    const manifest = JSON.parse(
      readFileSync(join(original.root, 'bridge', CURRENT_STRICT_BUNDLE_MANIFEST_FILE), 'utf8'),
    ) as {
      buildSetId: string;
    };
    const retained = join(home, '.coral', 'gen2', 'builds', manifest.buildSetId);
    mkdirSync(join(retained, '..'), { recursive: true });
    renameSync(original.root, retained);
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
    const registry = join(home, 'installed.json');
    writeFileSync(registry, JSON.stringify({ plugins: { 'coral@fixture': [{ installPath: installed.root }] } }));
    const supervisor = spawn(process.execPath, [harness, join(retained, 'bridge', 'coral-backend.cjs')], {
      env: {
        ...process.env,
        HOME: home,
        TMPDIR: home,
        CORAL_SENTINEL_RUN_DIR: runDir,
        CORAL_PLUGIN_REGISTRY: registry,
        CORAL_FIXTURE_FAIL_INSTALLED_ROOTS: installed.root,
        CORAL_FIXTURE_FAIL_AFTER_MS: '16000',
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    const record = new SupervisorEvidence(runDir);
    let firstPid: number | null = null;
    let finalPid: number | null = null;
    try {
      await waitForCondition(() => existsSync(join(runDir, 'coordinator.json')), 20_000);
      firstPid = (JSON.parse(readFileSync(join(runDir, 'coordinator.json'), 'utf8')) as { pid: number }).pid;
      supervisor.send({ kind: 'freeze-coordinator' });
      await waitForCondition(() => {
        const launch = record.read().launch;
        return launch?.buildSetId !== manifest.buildSetId && launch?.phase === 'admitted';
      }, 10_000);
      await new Promise((resolve) => setTimeout(resolve, 15_500));
      expect(supervisor.exitCode).toBeNull();
      expect(record.read().launch).toMatchObject({ phase: 'admitted' });
      await waitForCondition(() => {
        if (!existsSync(join(runDir, 'coordinator.json'))) return false;
        const pid = (JSON.parse(readFileSync(join(runDir, 'coordinator.json'), 'utf8')) as { pid: number }).pid;
        if (pid === firstPid) return false;
        const launch = record.read().launch;
        if (launch?.buildSetId !== manifest.buildSetId || launch.phase !== 'serving') return false;
        finalPid = pid;
        return true;
      }, 20_000);
      expect(supervisor.exitCode).toBeNull();
    } finally {
      record.close();
      if (supervisor.exitCode === null) supervisor.kill('SIGTERM');
      for (const pid of [firstPid, finalPid]) {
        if (pid === null) continue;
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          /* fixture already exited */
        }
      }
      for (const root of roots.reverse()) rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
  it('chooses the newest eligible request after a starting coordinator exits', async () => {
    const roots: string[] = [];
    const home = mkdtempSync(join(tmpdir(), 'coral-red-supervisor-version-order-'));
    roots.push(home);
    const starting = createPluginFixture(roots, { flavor: 'prod', version: '0.10.14', backend: 'sentinel-freeze' });
    const rollback = createPluginFixture(roots, {
      flavor: 'prod',
      version: '0.10.13',
      backend: 'admission-freeze',
    });
    const upgrade = createPluginFixture(roots, { flavor: 'prod', version: '0.10.16' });
    const registry = join(home, 'installed.json');
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
    const supervisor = spawn(process.execPath, [harness, join(starting.root, 'bridge', 'coral-backend.cjs')], {
      env: {
        ...process.env,
        HOME: home,
        TMPDIR: home,
        CORAL_SENTINEL_RUN_DIR: runDir,
        CORAL_PLUGIN_REGISTRY: registry,
        CORAL_FIXTURE_FAIL_INSTALLED_ROOTS: starting.root,
        CORAL_FIXTURE_FAIL_AFTER_MS: '3000',
      },
      stdio: 'ignore',
    });
    const record = new SupervisorEvidence(runDir);
    try {
      await waitForCondition(() => record.read().launch?.phase === 'admitted', 10_000);
      writeFileSync(registry, JSON.stringify({ plugins: { 'coral@fixture': [{ installPath: upgrade.root }] } }));
      await record.request(join(rollback.root, 'bridge', 'coral-backend.cjs'), buildSetId(rollback.root));
      await record.request(join(upgrade.root, 'bridge', 'coral-backend.cjs'), buildSetId(upgrade.root));

      await waitForCondition(() => record.read().launch?.buildSetId === buildSetId(upgrade.root), 20_000);

      expect(record.read().launch?.buildSetId).toBe(buildSetId(upgrade.root));
    } finally {
      const childPid = record.read().launch?.child?.pid;
      record.close();
      if (supervisor.exitCode === null) supervisor.kill('SIGKILL');
      if (childPid !== undefined) {
        try {
          process.kill(childPid, 'SIGKILL');
        } catch {
          // The fixture may already have exited.
        }
      }
      for (const root of roots.reverse()) rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('does not accumulate observation supervisors after unobservable acquisition and requester disconnection', async () => {
    const roots: string[] = [];
    const home = mkdtempSync(join(tmpdir(), 'coral-observer-disconnect-'));
    roots.push(home);
    const fixture = createPluginFixture(roots, { flavor: 'prod', version: '0.10.14', backend: 'admission-freeze' });
    const harness = join(home, 'observer.cjs');
    await build({
      entryPoints: [fileURLToPath(new URL('./fixtures/namespace-supervisor-harness.ts', import.meta.url))],
      outfile: harness,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      external: ['node:*'],
      banner: { js: 'var __fixtureImportMetaUrl=require("url").pathToFileURL(__filename).href;' },
      define: { 'import.meta.url': '__fixtureImportMetaUrl' },
      plugins: [
        {
          name: 'unobservable-observer-lock',
          setup(builder) {
            builder.onLoad({ filter: /\/infra\/fs-lock\.ts$/ }, ({ path }) => ({
              contents: readFileSync(path, 'utf8').replace(
                'export function attemptExclusiveFileLockSync(path: string, busyTimeoutMs = 0): ExclusiveFileLockAttempt {',
                `export function attemptExclusiveFileLockSync(path: string, busyTimeoutMs = 0): ExclusiveFileLockAttempt {
                if (process.env.CORAL_FIXTURE_UNOBSERVABLE_LOCK === '1') return { kind: 'unobservable', cause: new Error('fixture EACCES') };`,
              ),
              loader: 'ts',
            }));
          },
        },
      ],
    });
    const observers: ReturnType<typeof spawn>[] = [];
    let ownedChild: number | undefined;
    try {
      for (let trigger = 0; trigger < 3; trigger++) {
        const runDir = join(home, `run-${trigger}`);
        const observer = spawn(process.execPath, [harness, join(fixture.root, 'bridge', 'coral-backend.cjs')], {
          env: {
            ...process.env,
            HOME: home,
            TMPDIR: home,
            CORAL_SENTINEL_RUN_DIR: runDir,
            CORAL_OBSERVATION_CHALLENGE: 'fixture',
            CORAL_FIXTURE_UNOBSERVABLE_LOCK: '1',
          },
          stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        });
        observers.push(observer);
        await waitForCondition(() => readLaunchStatus(runDir).kind === 'readable', 5_000);
        expect(readLaunchStatus(runDir)).toMatchObject({
          kind: 'readable',
          status: { lockHold: { disposition: 'supervisor-lock-unobservable' } },
        });
        observer.disconnect();
        await waitForCondition(() => observer.exitCode !== null || observer.signalCode !== null, 1_000);
        expect(observers.filter((child) => child.exitCode === null && child.signalCode === null)).toHaveLength(0);
      }
      const runDir = join(home, 'owned');
      const observer = spawn(process.execPath, [harness, join(fixture.root, 'bridge', 'coral-backend.cjs')], {
        env: {
          ...process.env,
          HOME: home,
          TMPDIR: home,
          CORAL_SENTINEL_RUN_DIR: runDir,
          CORAL_OBSERVATION_CHALLENGE: 'fixture',
        },
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      });
      observers.push(observer);
      const record = new SupervisorEvidence(runDir, join(home, 'supervisor-memory.jsonl'));
      await waitForCondition(() => record.memory()?.launch?.phase === 'admitted', 5_000);
      ownedChild = record.memory()?.launch?.child?.pid;
      observer.disconnect();
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(observer.exitCode).toBeNull();
      expect(observer.signalCode).toBeNull();
      expect(record.lockHolder()?.pid).toBe(observer.pid);
    } finally {
      for (const observer of observers) {
        if (observer.connected) observer.disconnect();
        if (observer.exitCode === null && observer.signalCode === null) {
          const exited = new Promise<void>((resolve) => observer.once('exit', () => resolve()));
          observer.kill('SIGKILL');
          await exited;
        }
      }
      if (ownedChild !== undefined && !childHasExited(ownedChild)) process.kill(ownedChild, 'SIGKILL');
      for (const root of roots.reverse()) rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);

  it.skipIf(process.platform !== 'linux').each([
    ['readable', 0],
    ['corrupt', 0],
    ['readable', 10_000],
    ['readable', -10_000],
  ] as const)(
    'enforces the original %s admission deadline after takeover without resuming the stopped child (clock jump: %s)',
    async (admission, clockJump) => {
      const readWallClock = Date.now;
      const startedWall = readWallClock();
      const startedMonotonic = performance.now();
      const roots: string[] = [];
      const home = mkdtempSync(join(tmpdir(), 'coral-red-inherited-admission-'));
      roots.push(home);
      const stalled = createPluginFixture(roots, { flavor: 'prod', version: '0.10.14', backend: 'admission-freeze' });
      const recovery = createPluginFixture(roots, { flavor: 'prod', version: '0.10.16' });
      const independentHome = mkdtempSync(join(tmpdir(), 'coral-independent-service-'));
      roots.push(independentHome);
      const independentRunDir = coordinatorPaths('prod', { baseDir: join(independentHome, '.coral') }).runDir;
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
      const env = {
        ...process.env,
        HOME: home,
        TMPDIR: home,
        CORAL_SENTINEL_RUN_DIR: runDir,
        CORAL_FIXTURE_STARTUP_BUDGET_MS: '4000',
      };
      let parent: ReturnType<typeof spawn> | null = null;
      const record = new SupervisorEvidence(runDir);
      let replacement: ReturnType<typeof spawn> | null = null;
      let independent: ReturnType<typeof spawn> | null = null;
      let independentPid: number | undefined;
      let serviceProbe: ReturnType<typeof setInterval> | undefined;
      const serviceAnswers: Promise<boolean>[] = [];
      let stalledPid: number | undefined;
      try {
        independent = spawn(process.execPath, [harness, join(recovery.root, 'bridge', 'coral-backend.cjs')], {
          env: { ...env, HOME: independentHome, TMPDIR: independentHome, CORAL_SENTINEL_RUN_DIR: independentRunDir },
          stdio: 'ignore',
        });
        const independentRecord = new SupervisorEvidence(independentRunDir);
        try {
          await waitForCondition(() => independentRecord.read().launch?.phase === 'serving', 10_000);
          independentPid = independentRecord.read().launch?.child?.pid;
        } finally {
          independentRecord.close();
        }
        if (independentPid === undefined) throw new Error('Independent service missing');
        parent = spawn(process.execPath, [harness, join(stalled.root, 'bridge', 'coral-backend.cjs')], {
          env,
          stdio: 'ignore',
        });
        await waitForCondition(() => record.read().launch?.phase === 'admitted', 10_000);
        const admittedAt = record.read().launch?.admittedAt;
        const launchId = record.read().launch?.id;
        if (admittedAt === undefined) throw new Error('Admitted child has no admission time');
        if (launchId === undefined) throw new Error('Admitted child has no launch ID');
        stalledPid = record.read().launch?.child?.pid;
        if (stalledPid === undefined) throw new Error('Admitted child has no PID');
        expect(readLaunchAdmission(runDir, launchId)).toMatchObject({
          kind: 'readable',
          admission: { admittedAt, child: { pid: stalledPid } },
        });
        const subject = listLaunchSubjects(runDir).find((entry) => entry.admission?.launchId === launchId);
        if (subject?.lifetimePath === undefined || subject.inode === undefined)
          throw new Error('Missing lifetime inode');
        const admittedMonotonicMs = subject.admission?.admittedMonotonicMs;
        if (admittedMonotonicMs === undefined) throw new Error('Missing monotonic admission time');
        if (admission === 'corrupt') writeFileSync(launchAdmissionPath(runDir, launchId), '{');
        const observerIncarnation = probeProcessIncarnation(process.pid);
        if (observerIncarnation === null) throw new Error('Missing observer incarnation');
        const reconstructed = new SupervisorLaunchMemory(
          runDir,
          { pid: process.pid, incarnation: observerIncarnation },
          buildSetId(recovery.root),
        );
        expect(reconstructed.read().launch).toMatchObject({
          phase: 'admitted',
          admittedAt,
          child: { pid: stalledPid },
        });
        expect(reconstructed.supervisionEligible(reconstructed.read().launch!)).toBe(true);
        expect(readUpgradeIntent(runDir).kind).toBe('absent');
        expect(existsSync(join(runDir, 'coordinator.json'))).toBe(false);
        serviceProbe = setInterval(() => {
          serviceAnswers.push(replacementServing(independentRunDir, 'prod', independentPid!));
        }, 100);
        await waitForCondition(
          () => Number(process.hrtime.bigint() / 1_000_000n) >= admittedMonotonicMs + 2_800,
          4_000,
        );
        process.kill(stalledPid, 'SIGSTOP');
        parent.kill('SIGKILL');

        replacement = spawn(process.execPath, [harness, join(recovery.root, 'bridge', 'coral-backend.cjs')], {
          env,
          stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        });
        await waitForCondition(() => record.read().owner?.process.pid === replacement?.pid, 10_000);
        expect(record.lockHolder()?.pid).toBe(replacement.pid);
        expect(namespaceLockHolders(runDir)).toEqual([replacement.pid]);
        if (clockJump !== 0) {
          replacement.send({ fixtureClockJump: clockJump });
          vi.spyOn(Date, 'now').mockImplementation(() => readWallClock() + clockJump);
        }
        await waitForCondition(() => record.memory()?.launch?.child?.pid === stalledPid, 500);
        expect(record.memory()?.launch).toMatchObject({ phase: 'admitted', admittedAt, child: { pid: stalledPid } });
        expect(listLaunchSubjects(runDir).find((entry) => entry.admission?.launchId === launchId)).toMatchObject({
          admission: { admittedAt },
          inode: subject.inode,
        });
        if (admission === 'readable')
          expect(readLaunchAdmission(runDir, launchId)).toMatchObject({ kind: 'readable', admission: { admittedAt } });
        else expect(readLaunchAdmission(runDir, launchId).kind).toBe('unreadable');
        await waitForCondition(
          () =>
            stalledPid !== undefined && (observeProcessLiveness(stalledPid) === 'absent' || childHasExited(stalledPid)),
          Math.max(1, admittedMonotonicMs + 5_000 - Number(process.hrtime.bigint() / 1_000_000n)),
        );
        expect(
          Number(process.hrtime.bigint() / 1_000_000n),
          JSON.stringify({
            admittedAt,
            clockDrift: readWallClock() - startedWall - (performance.now() - startedMonotonic),
            memory: memoryObservations(join(home, 'supervisor-memory.jsonl')).slice(-10),
          }),
        ).toBeLessThan(admittedMonotonicMs + 5_000);
        const retirement = memoryObservations(join(home, 'supervisor-memory.jsonl')).filter(
          (event) =>
            event.pid === replacement?.pid &&
            event.state?.launch?.id === launchId &&
            event.state.launch.terminationAt !== undefined,
        );
        expect(retirement.length).toBeGreaterThan(0);
        expect(retirement.every((event) => event.monotonicAt! >= admittedMonotonicMs + 4_000)).toBe(true);
        await waitForCondition(() => !existsSync(subject.path) && !existsSync(subject.lifetimePath!), 2_000);
        expect(
          Number(process.hrtime.bigint() / 1_000_000n),
          JSON.stringify({
            clockDrift: readWallClock() - startedWall - (performance.now() - startedMonotonic),
            admittedAt,
            memory: memoryObservations(join(home, 'supervisor-memory.jsonl')).slice(-10),
          }),
        ).toBeLessThan(admittedMonotonicMs + 5_000);
        clearInterval(serviceProbe);
        expect(serviceAnswers.length).toBeGreaterThan(0);
        expect((await Promise.all(serviceAnswers)).every(Boolean)).toBe(true);
        expect(await replacementServing(independentRunDir, 'prod', independentPid)).toBe(true);
        await waitForCondition(() => {
          const launch = record.read().launch;
          return launch?.phase === 'serving' && launch.buildSetId === buildSetId(recovery.root);
        }, 10_000);
        expect(observeProcessLiveness(stalledPid) === 'absent' || childHasExited(stalledPid)).toBe(true);
      } finally {
        vi.restoreAllMocks();
        clearInterval(serviceProbe);
        const currentPid = record.read().launch?.child?.pid;
        record.close();
        const replacementProcess = replacement;
        const parentProcess = parent;
        const parentExit =
          parentProcess !== null && parentProcess.exitCode === null && parentProcess.signalCode === null
            ? new Promise<void>((resolve) => parentProcess.once('exit', () => resolve()))
            : Promise.resolve();
        const replacementExit =
          replacementProcess !== null && replacementProcess.exitCode === null && replacementProcess.signalCode === null
            ? new Promise<void>((resolve) => replacementProcess.once('exit', () => resolve()))
            : Promise.resolve();
        if (parentProcess !== null && parentProcess.exitCode === null && parentProcess.signalCode === null)
          parentProcess.kill('SIGKILL');
        independent?.kill('SIGKILL');
        if (
          replacementProcess !== null &&
          replacementProcess.exitCode === null &&
          replacementProcess.signalCode === null
        )
          replacementProcess.kill('SIGKILL');
        await Promise.all([parentExit, replacementExit]);
        for (const pid of [stalledPid, currentPid, independentPid]) {
          if (pid === undefined) continue;
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            // The fixture may already have exited.
          }
        }
        for (const root of roots.reverse()) rmSync(root, { recursive: true, force: true });
      }
    },
    15_000,
  );

  it.each([
    { phase: 'accepted recovery', removeInstallation: false },
    { phase: 'accepted recovery', removeInstallation: true },
    { phase: 'promotion', removeInstallation: false },
    { phase: 'promotion', removeInstallation: true },
  ] as const)(
    'restores supervision after replacement death following $phase (removed installation: $removeInstallation)',
    async ({ phase, removeInstallation }) => {
      const roots: string[] = [];
      const home = mkdtempSync(join(tmpdir(), 'coral-recovery-repeated-crash-'));
      roots.push(home);
      const plugin = createPluginFixture(roots, { flavor: 'prod', version: '0.10.14' });
      const expectedBuildSetId = buildSetId(plugin.root);
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
      const supervisor = spawn(process.execPath, [harness, join(plugin.root, 'bridge', 'coral-backend.cjs')], {
        env: { ...process.env, HOME: home, TMPDIR: home, CORAL_SENTINEL_RUN_DIR: runDir },
        stdio: 'ignore',
      });
      const record = new SupervisorEvidence(runDir);
      const pids = new Set<number>();
      const remember = (): ReturnType<typeof record.read> => {
        const state = record.read();
        for (const process of [
          state.owner?.process,
          state.launch?.parent,
          state.launch?.child,
          state.attempt?.parent,
          state.attempt?.child,
        ])
          if (process !== undefined) pids.add(process.pid);
        return state;
      };
      try {
        await waitForCondition(() => remember().launch?.phase === 'serving', 20_000);
        const firstChild = remember().launch?.child?.pid;
        if (firstChild === undefined) throw new Error('Initial coordinator has no PID');
        const retained = join(home, '.coral', 'gen2', 'builds', expectedBuildSetId, 'bridge', 'coral-backend.cjs');
        await waitForCondition(() => existsSync(retained), 10_000);
        if (removeInstallation) rmSync(plugin.root, { recursive: true, force: true });
        supervisor.kill('SIGKILL');
        await waitForCondition(() => {
          const state = remember();
          return (
            state.owner?.process.pid !== undefined &&
            state.owner?.process.pid !== supervisor.pid &&
            state.owner?.mode === 'recovering'
          );
        }, 15_000);
        let doomedChild = firstChild;
        if (phase === 'promotion') {
          await waitForCondition(() => {
            const state = remember();
            return (
              state.launch?.phase === 'serving' &&
              state.launch.child?.pid !== firstChild &&
              state.owner?.mode === 'supervised'
            );
          }, 25_000);
          doomedChild = remember().launch?.child?.pid ?? firstChild;
        }
        const doomedSupervisor = remember().owner?.process.pid;
        if (doomedSupervisor === undefined) throw new Error('Replacement has no PID');
        process.kill(doomedSupervisor, 'SIGKILL');
        await waitForCondition(() => {
          const state = remember();
          return (
            state.launch?.phase === 'serving' &&
            state.launch.child?.pid !== doomedChild &&
            state.owner?.process.pid !== undefined &&
            state.owner?.process.pid !== doomedSupervisor &&
            state.owner?.mode === 'supervised'
          );
        }, 40_000).catch((error: unknown) => {
          throw new Error(
            `Repeated replacement did not normalize: state=${JSON.stringify(remember())}; status=${JSON.stringify(readLaunchStatus(runDir))}`,
            { cause: error },
          );
        });
        const final = remember();
        expect(final.launch?.parent).toEqual(final.owner?.process);
        expect(final.launch?.buildSetId).toBe(expectedBuildSetId);
        expect(
          final.requests.every((request) => request.status === 'completed' || request.status === 'unavailable'),
        ).toBe(true);
      } finally {
        remember();
        record.close();
        if (supervisor.exitCode === null) supervisor.kill('SIGKILL');
        for (const pid of pids) {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            // The test process may already have exited.
          }
        }
        await waitForCondition(
          () => [...pids].every((pid) => observeProcessLiveness(pid) === 'absent' || childHasExited(pid)),
          3_000,
        );
        for (const root of roots.reverse()) rmSync(root, { recursive: true, force: true });
      }
    },
    75_000,
  );
});
