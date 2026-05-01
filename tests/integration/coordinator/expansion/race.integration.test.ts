import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { gzipSync } from 'node:zlib';

import * as esbuild from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { installResponseSchema } from '#src/expansion/rpc-contract.js';
import { spawnNodeScript } from '#tests/helpers/multi-process-driver.js';

type WorkerProcessResult = Awaited<ReturnType<typeof spawnNodeScript<unknown>>>;

function writeExecutable(filePath: string, body: string): void {
  writeFileSync(filePath, body, 'utf-8');
  chmodSync(filePath, 0o755);
}

function writeTarString(header: Buffer, value: string, offset: number, length: number): void {
  Buffer.from(value, 'utf-8').copy(header, offset, 0, length);
}

function writeTarOctal(header: Buffer, value: number, offset: number, length: number): void {
  const encoded = `${value.toString(8).padStart(length - 1, '0')}\0`;
  Buffer.from(encoded, 'utf-8').copy(header, offset, 0, length);
}

function createPrebuildArchive(filePath: string, entryName: string, content: Buffer): void {
  const header = Buffer.alloc(512, 0);
  writeTarString(header, entryName, 0, 100);
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
  const archive = Buffer.concat([header, content, Buffer.alloc(paddingSize, 0), Buffer.alloc(1024, 0)]);

  writeFileSync(filePath, gzipSync(archive));
}

function writeContendedCurl(binDir: string): void {
  writeExecutable(
    path.join(binDir, 'curl'),
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

async function waitForFirstCompletion(
  workers: readonly Promise<WorkerProcessResult>[],
  timeoutMs: number,
): Promise<WorkerProcessResult> {
  return await Promise.race([
    ...workers,
    delay(timeoutMs).then(() => {
      throw new Error('Timed out waiting for a worker to finish while the install lock was held.');
    }),
  ]);
}

describe.skipIf(process.platform === 'win32')('expansion multi-process race integration', () => {
  let invocationTempDir = '';
  let invocationCjsPath = '';

  beforeAll(async () => {
    invocationTempDir = mkdtempSync(path.join(os.tmpdir(), `coral-race-${process.pid}-`));
    invocationCjsPath = path.join(invocationTempDir, 'install-invocation.cjs');
    await esbuild.build({
      entryPoints: ['tests/helpers/invocation/install-invocation.ts'],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile: invocationCjsPath,
      external: [],
    });
  });

  afterAll(() => {
    if (invocationTempDir.length > 0) {
      rmSync(invocationTempDir, { recursive: true, force: true });
    }
  });

  it('lets exactly one worker install needle and leaves the shared expansion state intact', async () => {
    const testHome = mkdtempSync(path.join(os.tmpdir(), 'coral-test-'));
    const binDir = path.join(testHome, 'bin');
    const archivePath = path.join(testHome, 'coral-needle-prebuild.tar.gz');
    const curlReleasePath = path.join(testHome, 'fake-curl.release');
    const curlMarkDir = path.join(testHome, 'fake-curl-markers');
    const needleDir = path.join(testHome, '.coral', 'data-dev', 'engines', 'needle');
    const lockPath = path.join(needleDir, 'install.lock');
    const addonPath = path.join(needleDir, 'coral-needle.node');
    const addonBytes = Buffer.from('race-test-addon');

    mkdirSync(binDir, { recursive: true });
    writeContendedCurl(binDir);
    createPrebuildArchive(archivePath, 'coral-needle.node', addonBytes);

    const workerEnv = {
      ...process.env,
      HOME: testHome,
      USERPROFILE: testHome,
      TMPDIR: testHome,
      CORAL_HOME: testHome,
      CORAL_FLAVOR: 'dev',
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
      FAKE_CURL_ARCHIVE: archivePath,
      FAKE_CURL_MARK_DIR: curlMarkDir,
      FAKE_CURL_RELEASE_FILE: curlReleasePath,
    };

    const workers = [0, 1].map((workerId) =>
      spawnNodeScript<unknown>({
        scriptPath: invocationCjsPath,
        args: ['needle'],
        env: {
          ...workerEnv,
          CORAL_WORKER_ID: String(workerId),
        },
        timeoutMs: 15_000,
        parseStdout: JSON.parse,
      }),
    );
    for (const worker of workers) {
      void worker.catch(() => {});
    }

    try {
      await waitForCondition('the install lock to appear', () => existsSync(lockPath), 5_000);
      await waitForCondition(
        'the winner to reach the fake curl barrier',
        () => enteredWorkerIds(curlMarkDir).length >= 1,
        5_000,
      );
      expect(enteredWorkerIds(curlMarkDir)).toHaveLength(1);

      const firstCompleted = await waitForFirstCompletion(workers, 5_000);
      expect(installResponseSchema.parse(firstCompleted.parsed)).toMatchObject({
        status: 'error',
        code: 'expansion_install_lock_contended',
      });
      expect(existsSync(lockPath)).toBe(true);
      expect(enteredWorkerIds(curlMarkDir)).toHaveLength(1);

      writeFileSync(curlReleasePath, 'release', 'utf-8');

      const completedWorkers = await Promise.all(workers);
      const results = completedWorkers.map((worker) => installResponseSchema.parse(worker.parsed));
      const installSuccesses = results.filter((result) => result.status === 'installed');
      const lockContentionErrors = results.filter(
        (result) => result.status === 'error' && result.code === 'expansion_install_lock_contended',
      );

      expect(completedWorkers).toHaveLength(2);
      expect(installSuccesses).toHaveLength(1);
      expect(lockContentionErrors).toHaveLength(1);
      expect(readFileSync(addonPath)).toEqual(addonBytes);
      expect(readdirSync(needleDir).filter((entry) => entry.endsWith('.part'))).toEqual([]);
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      if (!existsSync(curlReleasePath)) {
        writeFileSync(curlReleasePath, 'release', 'utf-8');
      }
      await Promise.allSettled(workers);
      rmSync(testHome, { recursive: true, force: true });
    }
  });
});
