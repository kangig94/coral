import { readFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';

import type { StrictBundleManifest } from '../infra/bundle-manifest.js';
import { socketPathForRunDir } from '../infra/path/index.js';

export async function replacementServing(
  runDir: string,
  flavor: StrictBundleManifest['flavor'],
  pid: number,
): Promise<boolean> {
  try {
    const discovery = JSON.parse(readFileSync(join(runDir, 'coordinator.json'), 'utf8')) as {
      pid?: unknown;
      bootToken?: unknown;
    };
    if (discovery.pid !== pid) return false;
    if (typeof discovery.bootToken !== 'string') return false;
    const socketPath = socketPathForRunDir(runDir, flavor, { platform: process.platform });
    return await new Promise<boolean>((resolve) => {
      const socket = createConnection(socketPath);
      let received = '';
      let settled = false;
      const finish = (serving: boolean): void => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve(serving);
      };
      socket.setTimeout(500, () => finish(false));
      socket.once('error', () => finish(false));
      socket.once('close', () => finish(false));
      socket.once('connect', () => {
        socket.write(
          `${JSON.stringify({ kind: 'request', id: 1, method: 'transport.health', auth: { kind: 'boot', token: discovery.bootToken } })}\n`,
        );
      });
      socket.on('data', (chunk: Buffer) => {
        received += chunk.toString('utf8');
        if (received.length > 64 * 1024) return finish(false);
        const newline = received.indexOf('\n');
        if (newline === -1) return;
        try {
          const response = JSON.parse(received.slice(0, newline)) as {
            kind?: string;
            id?: number;
            result?: { pid?: number; status?: string };
          };
          finish(
            response.kind === 'response' &&
              response.id === 1 &&
              response.result?.pid === pid &&
              (response.result.status === 'ok' || response.result.status === 'running'),
          );
        } catch {
          finish(false);
        }
      });
    });
  } catch {
    return false;
  }
}

/** The parent-held ChildProcess is the only signal authority for this incarnation. */
