import { type ChildProcess, type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import { afterEach, describe, expect, it } from 'vitest';

import { pluginRootNamespace } from '#src/infra/plugin-identity.js';
import { observeProcessLiveness, probeProcessIncarnation } from '#src/infra/node-process.js';
import {
  assertBuildArtifactsAvailable,
  coordinatorFilesForHome,
  createPluginFixture,
} from '#tests/integration/coordinator/helpers.js';
import { waitForCondition } from '#tests/support/wait-for-condition.js';

const roots: string[] = [];
const children = new Set<ChildProcess>();
const incumbentFixturePath = join(process.cwd(), 'tests', 'fixtures', 'handoff-escalation-incumbent.cjs');
const bindFaultPreloadPath = join(process.cwd(), 'tests', 'fixtures', 'handoff-escalation-bind-fault.cjs');
const SECRET = 'AC8_PLANTED_BIND_FAILURE_71d592be';
const EXPECTED_CODE = 'handoff_accepted_signal_target_alive_after_failure';
const EXPECTED_REMEDIATION =
  'Wait for the identified target to finish shutting down or stop it through the service or account that owns it, then retry startup.';

type FixtureEvent = Readonly<Record<string, unknown> & { event: string }>;

type FixtureProcess = Readonly<{
  child: ChildProcessWithoutNullStreams;
  events: FixtureEvent[];
  stderr(): string;
  send(message: unknown): void;
}>;

type CliRun = Readonly<{
  child: ChildProcess;
  stdout(): string;
  stderr(): string;
  completed: Promise<number>;
}>;

function priorPatchVersion(version: string): string {
  const match = /^(\d+)\.(\d+)\.(\d+)/u.exec(version);
  if (match === null || Number(match[3]) === 0) {
    throw new Error(`Expected a product version with a positive patch component, received ${version}`);
  }
  return `${match[1]}.${match[2]}.${Number(match[3]) - 1}`;
}

function withoutNodeOptions(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const copy = { ...environment };
  delete copy.NODE_OPTIONS;
  return copy;
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

function startIncumbent(socketPath: string, infoPath: string, armMarker: string): FixtureProcess {
  const child = spawn(process.execPath, [incumbentFixturePath, socketPath, infoPath, armMarker], {
    env: withoutNodeOptions(process.env),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.add(child);
  child.once('close', () => children.delete(child));
  const events: FixtureEvent[] = [];
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    events.push(JSON.parse(line) as FixtureEvent);
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  return {
    child,
    events,
    stderr: () => stderr,
    send: (message) => child.stdin.write(`${JSON.stringify(message)}\n`),
  };
}

function startCli(root: string, args: readonly string[], env: NodeJS.ProcessEnv): CliRun {
  const child = spawn(process.execPath, [join(root, 'bridge', 'coral-cli.cjs'), ...args], {
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

async function waitForFixtureEvent(fixture: FixtureProcess, predicate: () => boolean, label: string): Promise<void> {
  await Promise.race([
    waitForCondition(predicate, 30_000),
    new Promise<never>((_, reject) => {
      fixture.child.once('close', (code, signal) => {
        reject(
          new Error(
            `${label}: fixture exited with code=${String(code)} signal=${String(signal)}\nstderr:\n${fixture.stderr()}`,
          ),
        );
      });
    }),
  ]);
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
  for (const root of roots.splice(0).reverse()) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('handoff escalation real terminal delivery', () => {
  it('preserves a bind failure as a private cause while projecting one documented refusal publicly', async () => {
    assertBuildArtifactsAvailable();
    const home = mkdtempSync(join(tmpdir(), 'coral-handoff-terminal-home-'));
    roots.push(home);
    const fixture = createPluginFixture(roots, { flavor: 'prod', bundleHash: 'terminal-path' });
    const manifest = JSON.parse(readFileSync(join(fixture.root, 'bridge', 'manifest.json'), 'utf-8')) as Readonly<{
      version: string;
      bundleHash: string;
      flavor: 'prod';
    }>;
    const files = coordinatorFilesForHome(home, manifest.flavor);
    const armMarker = join(home, 'handoff-bind-fault.arm');
    const faultObservation = join(home, 'handoff-bind-fault.jsonl');
    const incumbent = startIncumbent(files.socketPath, files.infoFile, armMarker);
    await waitForFixtureEvent(
      incumbent,
      () => incumbent.events.some((event) => event.event === 'listening'),
      'incumbent did not bind',
    );

    const incumbentPid = incumbent.child.pid;
    if (incumbentPid === undefined) throw new Error('Incumbent fixture did not receive a pid');
    const incarnation = probeProcessIncarnation(incumbentPid, process.platform);
    if (incarnation === null) throw new Error(`Could not probe fixture process incarnation for pid ${incumbentPid}`);
    const identity = {
      version: priorPatchVersion(manifest.version),
      bundleHash: '1111111111111111',
      flavor: manifest.flavor,
      namespace: pluginRootNamespace(fixture.root),
      instanceId: 'terminal-incumbent',
      incarnation,
      token: 'terminal-token',
      bootToken: 'terminal-boot-token',
      shutdownToken: 'terminal-shutdown-token',
    } as const;
    const nodeOptions = [process.env.NODE_OPTIONS, `--require=${bindFaultPreloadPath}`].filter(Boolean).join(' ');
    const mutating = startCli(fixture.root, ['abort', '--all'], {
      ...topLevelEnvironment(),
      HOME: home,
      TMPDIR: home,
      NODE_OPTIONS: nodeOptions,
      CORAL_HANDOFF_FAULT_SOCKET: files.socketPath,
      CORAL_HANDOFF_FAULT_ARM_MARKER: armMarker,
      CORAL_HANDOFF_FAULT_OBSERVATION: faultObservation,
      CORAL_HANDOFF_FAULT_SECRET: SECRET,
      CORAL_HANDOFF_SIGNAL_POLICY: 'term-kill',
    });

    await waitForFixtureEvent(
      incumbent,
      () => incumbent.events.filter((event) => event.event === 'request-blocked').length >= 2,
      'contender did not reach the incumbent while discovery was absent',
    );
    incumbent.send({ command: 'publish', identity });
    await waitForFixtureEvent(
      incumbent,
      () => incumbent.events.some((event) => event.event === 'shutdown-accepted'),
      'incumbent did not accept shutdown',
    );
    await waitForFixtureEvent(
      incumbent,
      () => incumbent.events.some((event) => event.event === 'sigterm-armed'),
      'accepted SIGTERM did not arm the bind failure',
    );
    await waitForCondition(() => existsSync(faultObservation), 10_000);

    await Promise.race([waitForCondition(() => existsSync(files.startupErrorFile), 20_000), mutating.completed]);
    incumbent.send({ command: 'clear' });
    await waitForFixtureEvent(
      incumbent,
      () => incumbent.events.some((event) => event.event === 'cleared'),
      'fixture cleanup acknowledgement was not observed',
    );

    const status = await mutating.completed;
    expect(status).toBe(69);
    const diagnostic = JSON.parse(readFileSync(files.startupDiagnosticFile, 'utf-8')) as Readonly<{
      error: unknown;
    }>;
    expect(diagnostic.error).toMatchObject({
      kind: 'coral_setup_error',
      code: EXPECTED_CODE,
      cause: { kind: 'error', name: 'Error', message: SECRET },
    });
    const intercepted = readFileSync(faultObservation, 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Readonly<{ event: string; requestedAddress: string }>);
    expect(intercepted).toEqual([
      { event: 'armed-bind-intercepted', pid: expect.any(Number), requestedAddress: files.socketPath },
    ]);

    const terminalOutput = `${mutating.stdout()}${mutating.stderr()}`;
    expect(terminalOutput).toContain(`[code=${EXPECTED_CODE}]`);
    expect(terminalOutput).toContain(
      `Handoff failed after accepted SIGTERM for incumbent pid=${incumbentPid}: the target was not observed gone before another handoff operation failed.`,
    );
    expect(terminalOutput).toContain(EXPECTED_REMEDIATION);
    expect(terminalOutput).not.toContain(SECRET);
    expect(terminalOutput).not.toContain('backend_unreachable');

    expect(observeProcessLiveness(incumbentPid)).toBe('alive');
    expect(existsSync(files.socketPath)).toBe(true);
    expect(existsSync(files.infoFile)).toBe(false);
    const backendStatus = startCli(fixture.root, ['backend', 'status'], {
      ...withoutNodeOptions(topLevelEnvironment()),
      HOME: home,
      TMPDIR: home,
    });
    const backendStatusExit = await backendStatus.completed;
    const backendStatusOutput = `${backendStatus.stdout()}${backendStatus.stderr()}`;
    expect(backendStatusExit).toBe(0);
    expect(backendStatusOutput).toContain('Coral recorded a recent coordinator failure.');
    expect(backendStatusOutput).toContain(`[code=${EXPECTED_CODE}]`);
    expect(backendStatusOutput).toContain(EXPECTED_REMEDIATION);
    expect(backendStatusOutput).not.toContain(SECRET);
    expect(backendStatusOutput).not.toContain('backend_unreachable');
  }, 120_000);
});
