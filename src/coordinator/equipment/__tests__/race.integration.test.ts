import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';

import { equipmentAddonPath, equipmentDataDir, equipmentInstallLockPath } from '../../../infra/equipment-paths.js';

const NEEDLE_VERSION = '0.2.0';
const createdRoots: string[] = [];

type WorkerResult = {
  readonly workerId: number;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly result: Record<string, unknown>;
};

type FakeCoordinator = {
  readonly registerCalls: number;
  readonly unregisterCalls: number;
  readonly registered: boolean;
  close(): Promise<void>;
};

type RunningWorker = {
  readonly workerId: number;
  readonly child: ChildProcessByStdio<null, Readable, Readable>;
  readonly completion: Promise<WorkerResult>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function writeExecutable(path: string, body: string): void {
  writeFileSync(path, body, 'utf-8');
  chmodSync(path, 0o755);
}

function writeTarString(header: Buffer, value: string, offset: number, length: number): void {
  Buffer.from(value, 'utf-8').copy(header, offset, 0, length);
}

function writeTarOctal(header: Buffer, value: number, offset: number, length: number): void {
  const encoded = `${value.toString(8).padStart(length - 1, '0')}\0`;
  Buffer.from(encoded, 'utf-8').copy(header, offset, 0, length);
}

function createPrebuildArchive(path: string, fileName: string, content: Buffer): void {
  const header = Buffer.alloc(512, 0);
  writeTarString(header, fileName, 0, 100);
  writeTarOctal(header, 0o644, 100, 8);
  writeTarOctal(header, 0, 108, 8);
  writeTarOctal(header, 0, 116, 8);
  writeTarOctal(header, content.length, 124, 12);
  writeTarOctal(header, Math.floor(Date.now() / 1000), 136, 12);
  header.fill(0x20, 148, 156);
  header[156] = '0'.charCodeAt(0);
  writeTarString(header, 'ustar', 257, 6);
  writeTarString(header, '00', 263, 2);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeTarOctal(header, checksum, 148, 8);

  const paddingSize = (512 - (content.length % 512)) % 512;
  const archive = Buffer.concat([
    header,
    content,
    Buffer.alloc(paddingSize, 0),
    Buffer.alloc(1024, 0),
  ]);

  writeFileSync(path, gzipSync(archive));
}

function writeContendedCurl(binDir: string): void {
  writeExecutable(
    join(binDir, 'curl'),
    `#!/bin/sh
dest=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-o" ]; then
    dest="$2"
    shift 2
    continue
  fi
  shift
done
if [ -z "$dest" ]; then
  echo "missing -o" >&2
  exit 1
fi
if [ -n "$FAKE_CURL_MARK_DIR" ] && [ -n "$CORAL_WORKER_ID" ]; then
  mkdir -p "$FAKE_CURL_MARK_DIR"
  : > "$FAKE_CURL_MARK_DIR/worker-$CORAL_WORKER_ID.entered"
fi
if [ -n "$FAKE_CURL_RELEASE_FILE" ]; then
  while [ ! -f "$FAKE_CURL_RELEASE_FILE" ]; do
    sleep 0.01
  done
elif [ -n "$FAKE_CURL_DELAY_MS" ]; then
  sleep "$FAKE_CURL_DELAY_MS"
fi
cp "$FAKE_CURL_ARCHIVE" "$dest"
`,
  );
}

function parseWorkerResult(stdout: string): Record<string, unknown> {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    throw new Error('Worker did not emit JSON output.');
  }

  const parsed = JSON.parse(lines[lines.length - 1] ?? '') as unknown;
  if (!isRecord(parsed)) {
    throw new Error('Worker JSON output must be an object.');
  }

  return parsed;
}

function spawnEquipWorkersWithStartBarrier(opts: {
  home: string;
  workers: number;
  catalog: string;
  startBarrierPath: string;
}): RunningWorker[] {
  const scriptPath = join(process.cwd(), 'scripts', 'equip-driver.mjs');
  const scriptUrl = pathToFileURL(scriptPath).href;
  const binDir = join(opts.home, 'bin');
  const bootstrap = `
import { existsSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

const barrierPath = process.env.CORAL_EQUIP_TEST_START_BARRIER;
const catalog = process.env.CORAL_EQUIP_TEST_CATALOG;
if (!barrierPath || !catalog) {
  throw new Error('CORAL_EQUIP_TEST_START_BARRIER and CORAL_EQUIP_TEST_CATALOG are required');
}

while (!existsSync(barrierPath)) {
  await delay(10);
}

process.argv = [process.execPath, ${JSON.stringify(scriptPath)}, catalog];
await import(${JSON.stringify(scriptUrl)});
`;

  return Array.from({ length: opts.workers }, (_, workerId) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', bootstrap], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: opts.home,
        USERPROFILE: opts.home,
        TMPDIR: opts.home,
        CORAL_HOME: opts.home,
        CLAUDE_PLUGIN_ROOT: process.cwd(),
        CORAL_WORKER_ID: String(workerId),
        CORAL_EQUIP_TEST_START_BARRIER: opts.startBarrierPath,
        CORAL_EQUIP_TEST_CATALOG: opts.catalog,
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    const completion = new Promise<WorkerResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`Timed out waiting for equip worker ${workerId}.\n${stdout}${stderr}`));
      }, 15_000);
      timer.unref?.();

      child.stdout.setEncoding('utf-8');
      child.stderr.setEncoding('utf-8');
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
      });
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('close', (code, signal) => {
        clearTimeout(timer);

        let result: Record<string, unknown>;
        try {
          result = parseWorkerResult(stdout);
        } catch (error) {
          reject(
            error instanceof Error
              ? new Error(`Could not parse worker ${workerId} output.\nstdout:\n${stdout}\nstderr:\n${stderr}`, {
                  cause: error,
                })
              : new Error(`Worker ${workerId} produced non-Error rejection.\nstdout:\n${stdout}\nstderr:\n${stderr}`, {
                  cause: error,
                }),
          );
          return;
        }

        resolve({
          workerId,
          exitCode: code,
          signal,
          stdout,
          stderr,
          result,
        });
      });
    });

    return {
      workerId,
      child,
      completion,
    };
  });
}

function enteredWorkerIds(markDir: string): number[] {
  if (!existsSync(markDir)) {
    return [];
  }

  return readdirSync(markDir)
    .map((entry) => /^worker-(\d+)\.entered$/.exec(entry))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => Number.parseInt(match[1] ?? '', 10));
}

async function waitForCondition(description: string, predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await delay(10);
  }

  throw new Error(`Timed out waiting for ${description}.`);
}

async function waitForFirstCompletion(workers: RunningWorker[], timeoutMs: number): Promise<WorkerResult> {
  return await Promise.race([
    ...workers.map((worker) => worker.completion),
    delay(timeoutMs).then(() => {
      throw new Error(`Timed out waiting for a worker to finish while the install lock was held.`);
    }),
  ]);
}

async function stopWorkers(workers: RunningWorker[]): Promise<void> {
  await Promise.all(
    workers.map(
      (worker) =>
        new Promise<void>((resolve) => {
          if (worker.child.exitCode !== null || worker.child.signalCode !== null) {
            resolve();
            return;
          }

          worker.child.once('close', () => resolve());
          worker.child.kill('SIGKILL');
        }),
    ),
  );
}

function writeCoordinatorDiscovery(home: string, socketPath: string): void {
  const coralBaseDir = join(home, '.coral');
  for (const runDir of [join(coralBaseDir, 'run'), join(coralBaseDir, 'run-dev')]) {
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'coordinator.json'), JSON.stringify({ socketPath }), 'utf-8');
  }
}

async function startFakeCoordinator(home: string): Promise<FakeCoordinator> {
  const socketPath = join(home, 'coordinator.sock');
  let registerCalls = 0;
  let unregisterCalls = 0;
  let registered = false;

  rmSync(socketPath, { force: true });

  const server = createServer((socket) => {
    let buffer = '';

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf-8');

      while (buffer.includes('\n')) {
        const newlineIndex = buffer.indexOf('\n');
        const frame = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (frame.length === 0) {
          continue;
        }

        const request = JSON.parse(frame) as { id: number | string; method: string };
        let payload: unknown;

        switch (request.method) {
          case 'coordinator.registerEquipment':
            registerCalls += 1;
            if (!registered) {
              registered = true;
              payload = {
                status: 'equipped',
                equipment: {
                  slot: 'kb.vector',
                  name: 'needle',
                  status: 'equipped',
                },
              };
            } else {
              payload = {
                status: 'already_equipped',
                equipment: {
                  slot: 'kb.vector',
                  name: 'needle',
                  status: 'equipped',
                },
              };
            }
            break;
          case 'coordinator.unregisterEquipment':
            unregisterCalls += 1;
            if (registered) {
              registered = false;
              payload = { status: 'uninstalled' };
            } else {
              payload = { status: 'not_equipped' };
            }
            break;
          case 'coordinator.listEquipment':
            payload = {
              equipment: registered
                ? [
                    {
                      slot: 'kb.vector',
                      name: 'needle',
                      status: 'equipped',
                    },
                  ]
                : [],
            };
            break;
          default:
            socket.end(
              JSON.stringify({
                kind: 'error',
                id: request.id,
                error: {
                  code: -32601,
                  message: `Unknown method: ${request.method}`,
                },
              }) + '\n',
            );
            continue;
        }

        socket.end(
          JSON.stringify({
            kind: 'response',
            id: request.id,
            result: payload,
          }) + '\n',
        );
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => resolve());
  });

  writeCoordinatorDiscovery(home, socketPath);

  return {
    get registerCalls() {
      return registerCalls;
    },
    get unregisterCalls() {
      return unregisterCalls;
    },
    get registered() {
      return registered;
    },
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
      rmSync(socketPath, { force: true });
    },
  };
}

afterEach(() => {
  for (const root of createdRoots.splice(0).reverse()) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('equipment multi-process race integration', () => {
  it('lets exactly one worker install needle and leaves the shared state intact', async () => {
    const home = mkdtempSync(join(tmpdir(), 'coral-equipment-race-home-'));
    const coralBaseDir = join(home, '.coral');
    const binDir = join(home, 'bin');
    const archivePath = join(home, 'coral-needle-prebuild.tar.gz');
    const startBarrierPath = join(home, 'equip-start.ready');
    const curlReleasePath = join(home, 'fake-curl.release');
    const curlMarkDir = join(home, 'fake-curl-markers');
    const addonBytes = Buffer.from('race-test-addon');
    createdRoots.push(home);

    mkdirSync(binDir, { recursive: true });
    writeContendedCurl(binDir);
    createPrebuildArchive(archivePath, 'coral-needle.node', addonBytes);
    process.env.FAKE_CURL_ARCHIVE = archivePath;
    process.env.FAKE_CURL_MARK_DIR = curlMarkDir;
    process.env.FAKE_CURL_RELEASE_FILE = curlReleasePath;

    const coordinator = await startFakeCoordinator(home);
    const lockPath = equipmentInstallLockPath('needle', { baseDir: coralBaseDir });

    try {
      const workers = spawnEquipWorkersWithStartBarrier({
        home,
        workers: 2,
        catalog: 'needle',
        startBarrierPath,
      });
      let results: WorkerResult[] = [];

      try {
        writeFileSync(startBarrierPath, 'go', 'utf-8');

        await waitForCondition('the install lock to appear', () => existsSync(lockPath), 5_000);
        await waitForCondition('the winner to reach the fake curl barrier', () => enteredWorkerIds(curlMarkDir).length >= 1, 5_000);
        expect(enteredWorkerIds(curlMarkDir)).toHaveLength(1);

        const firstCompleted = await waitForFirstCompletion(workers, 5_000);
        expect(existsSync(lockPath)).toBe(true);
        expect(enteredWorkerIds(curlMarkDir)).toHaveLength(1);
        expect(firstCompleted.result).toMatchObject({
          status: 'error',
          code: 'equipment_install_lock_contended',
        });

        writeFileSync(curlReleasePath, 'release', 'utf-8');
        results = await Promise.all(workers.map((worker) => worker.completion));
      } finally {
        if (!existsSync(curlReleasePath)) {
          writeFileSync(curlReleasePath, 'release', 'utf-8');
        }
        await stopWorkers(workers);
      }

      const successes = results.filter((worker) => {
        const status = worker.result.status;
        return status === 'equipped' || status === 'catching_up';
      });
      const contended = results.filter(
        (worker) => worker.result.status === 'error' && worker.result.code === 'equipment_install_lock_contended',
      );

      expect(successes).toHaveLength(1);
      expect(contended).toHaveLength(1);
      expect(results.some((worker) => worker.result.status === 'already_equipped')).toBe(false);

      const completedInstalls = results.filter((worker) => {
        const install = worker.result.install;
        return isRecord(install) && (install.status === 'installed' || install.status === 'updated');
      });
      expect(completedInstalls).toHaveLength(1);

      expect(coordinator.registerCalls).toBe(1);

      const addonPath = equipmentAddonPath('needle', { baseDir: coralBaseDir });
      const targetDir = equipmentDataDir('needle', { baseDir: coralBaseDir });
      const partialAddonPath = `${addonPath}.part`;
      const metaPath = join(targetDir, '.needle-meta.json');

      expect(readFileSync(addonPath)).toEqual(addonBytes);
      expect(existsSync(partialAddonPath)).toBe(false);
      expect(existsSync(lockPath)).toBe(false);
      expect(JSON.parse(readFileSync(metaPath, 'utf-8'))).toEqual({
        version: NEEDLE_VERSION,
        method: 'prebuild',
      });

      const coordinatorClient = await import(new URL('../../../../skills/equip/coordinator-client.mjs', import.meta.url).href);
      await expect(coordinatorClient.listEquipment({}, { baseDir: coralBaseDir })).resolves.toEqual({
        equipment: [
          {
            slot: 'kb.vector',
            name: 'needle',
            status: 'equipped',
          },
        ],
      });
      expect(coordinator.registered).toBe(true);
    } finally {
      delete process.env.FAKE_CURL_ARCHIVE;
      delete process.env.FAKE_CURL_MARK_DIR;
      delete process.env.FAKE_CURL_RELEASE_FILE;
      await coordinator.close();
    }
  });
});
