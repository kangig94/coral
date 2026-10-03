import { readFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';

import type { StrictBundleManifest } from '../infra/bundle-manifest.js';
import { socketPathForRunDir } from '../infra/path/index.js';
import { SUCCESSION_METHODS } from '../infra/succession-address.js';

export async function replacementServing(
  runDir: string,
  flavor: StrictBundleManifest['flavor'],
  pid: number,
): Promise<boolean | 'unknown'> {
  try {
    const discovery = JSON.parse(readFileSync(join(runDir, 'coordinator.json'), 'utf8')) as {
      pid?: unknown;
      bootToken?: unknown;
    };
    if (typeof discovery?.pid !== 'number' || typeof discovery.bootToken !== 'string') return 'unknown';
    if (discovery.pid !== pid) return false;
    const socketPath = socketPathForRunDir(runDir, flavor, { platform: process.platform });
    return await new Promise<boolean | 'unknown'>((resolve) => {
      const socket = createConnection(socketPath);
      let received = '';
      let settled = false;
      const finish = (serving: boolean | 'unknown'): void => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve(serving);
      };
      socket.setTimeout(500, () => finish(received.length === 0 ? false : 'unknown'));
      socket.once('error', () => finish(received.length === 0 ? false : 'unknown'));
      socket.once('close', () => finish(received.length === 0 ? false : 'unknown'));
      socket.once('connect', () => {
        socket.write(
          `${JSON.stringify({ kind: 'request', id: 1, method: 'transport.health', auth: { kind: 'boot', token: discovery.bootToken } })}\n`,
        );
      });
      socket.on('data', (chunk: Buffer) => {
        received += chunk.toString('utf8');
        if (Buffer.byteLength(received) > 64 * 1024) return finish('unknown');
        const newline = received.indexOf('\n');
        if (newline === -1) return;
        try {
          const response = JSON.parse(received.slice(0, newline)) as {
            kind?: string;
            id?: number;
            result?: { pid?: number; status?: string };
          };
          if (response?.kind !== 'response' || response.id !== 1 || response.result?.pid !== pid)
            return finish('unknown');
          const status = response.result.status;
          if (status === 'ok' || status === 'running') finish(true);
          else if (status === 'starting' || status === 'draining' || status === 'stopping') finish(false);
          else finish('unknown');
        } catch {
          finish('unknown');
        }
      });
    });
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? false : 'unknown';
  }
}

export async function requestInheritedSuccession(
  runDir: string,
  flavor: StrictBundleManifest['flavor'],
  pid: number,
  requestId: string,
  target: Readonly<{ build: StrictBundleManifest; pluginRootLabel: string }>,
  authorized: () => boolean,
): Promise<boolean> {
  try {
    const discovery = JSON.parse(readFileSync(join(runDir, 'coordinator.json'), 'utf8')) as {
      pid?: unknown;
      bootToken?: unknown;
    };
    if (discovery.pid !== pid || typeof discovery.bootToken !== 'string') return false;
    const socketPath = socketPathForRunDir(runDir, flavor, { platform: process.platform });
    return await new Promise<boolean>((resolve) => {
      const socket = createConnection(socketPath);
      let received = '';
      let settled = false;
      const finish = (registered: boolean): void => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve(registered);
      };
      socket.setTimeout(1_000, () => finish(false));
      socket.once('error', () => finish(false));
      socket.once('close', () => finish(false));
      socket.once('connect', () => {
        if (!authorized()) return finish(false);
        socket.write(
          `${JSON.stringify({
            kind: 'request',
            id: 1,
            method: SUCCESSION_METHODS.request,
            params: { requestId, target },
            auth: { kind: 'boot', token: discovery.bootToken },
          })}\n`,
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
            result?: { kind?: string };
          };
          finish(response.kind === 'response' && response.result?.kind === 'registered');
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
