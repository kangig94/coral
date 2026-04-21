import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';

import { equipmentAddonPath, equipmentDataDir, equipmentInstallLockPath } from '../../../infra/equipment-paths.js';
import { spawnEquipWorkers } from '../../../testing/multi-process-driver.js';

const NEEDLE_VERSION = '0.2.0';
const createdRoots: string[] = [];

type FakeCoordinator = {
  readonly registerCalls: number;
  readonly unregisterCalls: number;
  readonly registered: boolean;
  close(): Promise<void>;
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

function writeSlowCurl(binDir: string): void {
  writeExecutable(
    join(binDir, 'curl'),
    `#!/bin/sh
sleep "\${FAKE_CURL_DELAY_MS:-1}"
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
cp "$FAKE_CURL_ARCHIVE" "$dest"
`,
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
    const addonBytes = Buffer.from('race-test-addon');
    createdRoots.push(home);

    mkdirSync(binDir, { recursive: true });
    writeSlowCurl(binDir);
    createPrebuildArchive(archivePath, 'coral-needle.node', addonBytes);
    process.env.FAKE_CURL_ARCHIVE = archivePath;
    process.env.FAKE_CURL_DELAY_MS = '1';

    const coordinator = await startFakeCoordinator(home);

    try {
      const results = await spawnEquipWorkers({
        home,
        workers: 2,
        catalog: 'needle',
      });

      const successes = results.filter((worker) => {
        const status = worker.result.status;
        return status === 'equipped' || status === 'catching_up';
      });
      const followers = results.filter((worker) => !successes.includes(worker));

      expect(successes).toHaveLength(1);
      expect(followers).toHaveLength(1);

      const completedInstalls = results.filter((worker) => {
        const install = worker.result.install;
        return isRecord(install) && (install.status === 'installed' || install.status === 'updated');
      });
      expect(completedInstalls).toHaveLength(1);

      const follower = followers[0];
      expect(follower).toBeDefined();
      expect(
        follower?.result.code === 'equipment_install_lock_contended' || follower?.result.status === 'already_equipped',
      ).toBe(true);

      if (follower?.result.status === 'already_equipped') {
        expect(coordinator.registerCalls).toBe(2);
      } else {
        expect(follower?.result.code).toBe('equipment_install_lock_contended');
        expect(coordinator.registerCalls).toBe(1);
      }

      const addonPath = equipmentAddonPath('needle', { baseDir: coralBaseDir });
      const targetDir = equipmentDataDir('needle', { baseDir: coralBaseDir });
      const lockPath = equipmentInstallLockPath('needle', { baseDir: coralBaseDir });
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
      delete process.env.FAKE_CURL_DELAY_MS;
      await coordinator.close();
    }
  });
});
