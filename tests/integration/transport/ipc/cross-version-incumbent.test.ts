import { Command } from 'commander';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server as NetServer } from 'node:net';
import { platform, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('#src/cli/read-store.js', () => ({
  getSharedReadCoralStore: vi.fn(),
}));

import { makeClient } from '#src/cli/dispatch.js';
import {
  createProviderProxySetCommandOperations,
  createRecoveryQuarantineCommandOperations,
} from '#src/cli/commands/backend.js';
import { coordinatorPaths, v0109CoordinatorSocketGuardSetForRunDir } from '#src/infra/path/coordinator.js';
import { KB_DISABLED_REASON } from '#src/infra/kb-toggle.js';
import type { ProviderProxySetAddress } from '#src/provider-proxy/set-address.js';
import {
  ensure,
  mayInvocationBeServedByIncumbent,
  mayProcessReplaceIncumbent,
  type RawCoordinatorHealth,
} from '#src/transport/ipc/ensure.js';
import {
  decode,
  encode,
  type JsonRpcErrorEnvelope,
  type JsonRpcRequestEnvelope,
  type JsonRpcResponseEnvelope,
} from '#src/transport/ipc/json-rpc.js';

const incumbentInstanceId = 'healthy-foreign-incumbent';
const providerProxySetAddress: ProviderProxySetAddress = {
  buildSetId: '11111111-1111-4111-8111-111111111111',
  hostFingerprint: 'a'.repeat(64),
  proxyInstanceId: '22222222-2222-4222-8222-222222222222',
};
const tempRoots: string[] = [];
const servers = new Set<NetServer>();

function makeTempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function createInvokingPluginRoot(): string {
  const root = makeTempRoot('coral-foreign-invoking-build-');
  mkdirSync(join(root, 'bridge'), { recursive: true });
  writeFileSync(
    join(root, 'bridge', 'manifest.json'),
    JSON.stringify({ bundleHash: 'invoking-build-hash', flavor: 'prod' }),
    'utf8',
  );
  writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '2.0.0' }), 'utf8');
  return root;
}

function incumbentHealth(status: RawCoordinatorHealth['status'] = 'ok'): RawCoordinatorHealth {
  return {
    status,
    version: '1.0.0',
    bundleHash: 'incumbent-build-hash',
    flavor: 'prod',
    instanceId: incumbentInstanceId,
    namespace: 'incumbent-build-namespace',
    pid: process.pid,
    components: [{ id: 'kb', phase: 'offline', reason: KB_DISABLED_REASON }],
  };
}

function writeIncumbentDiscovery(socketPath: string): void {
  const paths = coordinatorPaths('prod');
  mkdirSync(dirname(paths.infoFile), { recursive: true });
  writeFileSync(
    paths.infoFile,
    JSON.stringify({
      pid: process.pid,
      port: 4100,
      socketPath,
      bundleHash: 'incumbent-build-hash',
      flavor: 'prod',
      namespace: 'incumbent-build-namespace',
      startedAt: Date.now(),
      token: 'incumbent-token',
      bootToken: 'incumbent-boot-token',
      version: '1.0.0',
      instanceId: incumbentInstanceId,
    }),
    'utf8',
  );
}

async function startIncumbent(
  socketPath: string,
  reply: (request: JsonRpcRequestEnvelope) => JsonRpcResponseEnvelope | JsonRpcErrorEnvelope,
): Promise<void> {
  mkdirSync(dirname(socketPath), { recursive: true });
  const server = createServer((socket) => {
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const frames = buffer.split('\n');
      buffer = frames.pop() ?? '';
      for (const frame of frames) {
        if (frame.trim().length === 0) continue;
        const request = decode(frame);
        if (request.kind !== 'request') continue;
        socket.end(`${encode(reply(request))}\n`);
      }
    });
  });
  servers.add(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function kbReindexCommand(): Command {
  const program = new Command();
  return program.command('kb').command('reindex');
}

afterEach(async () => {
  for (const server of servers) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  servers.clear();
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
  vi.unstubAllEnvs();
});

describe('cross-version incumbent', () => {
  it('should let every healthy incumbent serve regardless of build', () => {
    const health = incumbentHealth();

    expect(mayInvocationBeServedByIncumbent(health)).toBe(true);
    expect(mayInvocationBeServedByIncumbent({ ...health, status: 'draining' })).toBe(false);
    expect(mayInvocationBeServedByIncumbent(null)).toBe(false);
  });

  it('should permit replacement only without a serving incumbent', () => {
    const health = incumbentHealth();

    expect(mayProcessReplaceIncumbent(health)).toBe(false);
    expect(mayProcessReplaceIncumbent({ ...health, status: 'draining' })).toBe(true);
    expect(mayProcessReplaceIncumbent(null)).toBe(true);
  });

  it('should preserve the incumbent through a foreign-build KB-disabled CLI invocation', async () => {
    const home = makeTempRoot('coral-cross-version-home-');
    const pluginRoot = createInvokingPluginRoot();
    vi.stubEnv('HOME', home);
    vi.stubEnv('CLAUDE_CONFIG_DIR', '');
    vi.stubEnv('CODEX_HOME', '');
    vi.stubEnv('CLAUDE_PLUGIN_ROOT', pluginRoot);
    vi.stubEnv('CORAL_CHILD', '');
    vi.stubEnv('CORAL_CHILD_PRINCIPAL_HANDLE', '');
    vi.stubEnv('CORAL_JOB_ID', '');
    vi.stubEnv('CORAL_SESSION_ID', '');
    vi.stubEnv('CORAL_KB_ENABLE', '1');

    const paths = coordinatorPaths('prod');
    writeIncumbentDiscovery(paths.socketPath);
    const methods: string[] = [];
    let shutdownRequests = 0;
    await startIncumbent(paths.socketPath, (request) => {
      methods.push(request.method);
      if (request.method === 'transport.ping' || request.method === 'transport.health') {
        return { kind: 'response', id: request.id, result: incumbentHealth() };
      }
      if (request.method === 'transport.shutdown') {
        shutdownRequests += 1;
        return { kind: 'response', id: request.id, result: { status: 'draining' } };
      }
      if (request.method === 'kb.reindex') {
        return { kind: 'response', id: request.id, result: { status: 'running' } };
      }
      return { kind: 'response', id: request.id, result: null };
    });
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const before = await ensure(pluginRoot);
    const client = makeClient(pluginRoot, kbReindexCommand());
    await client.kbReindex({ async: true });
    const after = await ensure(pluginRoot);

    expect(before.instanceId).toBe(incumbentInstanceId);
    expect(after.instanceId).toBe(before.instanceId);
    expect(methods).toContain('transport.health');
    expect(methods).toContain('kb.reindex');
    expect(shutdownRequests).toBe(0);
    expect(stderrWrite).toHaveBeenCalledTimes(1);
    expect(stderrWrite).toHaveBeenCalledWith(
      'KB is disabled on the running Coral coordinator; this command will fail. Continuing without a ' +
        'restart so in-flight work is not interrupted.\n',
    );
  });

  it('reaches a shipped coordinator fallback on a long state root for both new no-verdict commands', async () => {
    const homeRoot = makeTempRoot('coral-cross-version-long-home-');
    const home = join(homeRoot, 'state-root-' + 'x'.repeat(140));
    const configuredTempDirectory = makeTempRoot('coral-v0109-socket-');
    const pluginRoot = createInvokingPluginRoot();
    mkdirSync(home, { recursive: true });
    vi.stubEnv('HOME', home);
    vi.stubEnv('TMPDIR', configuredTempDirectory);
    vi.stubEnv('CLAUDE_CONFIG_DIR', '');
    vi.stubEnv('CODEX_HOME', '');
    vi.stubEnv('CLAUDE_PLUGIN_ROOT', pluginRoot);
    vi.stubEnv('CORAL_CHILD', '');
    vi.stubEnv('CORAL_CHILD_PRINCIPAL_HANDLE', '');
    vi.stubEnv('CORAL_JOB_ID', '');
    vi.stubEnv('CORAL_SESSION_ID', '');

    const paths = coordinatorPaths('prod');
    const shippedAddresses = v0109CoordinatorSocketGuardSetForRunDir(paths.runDir, 'prod', {
      platform: platform(),
      configuredTempDirectory,
      systemTempDirectory: tmpdir(),
    });
    if (shippedAddresses.kind !== 'guarded-addresses' || shippedAddresses.paths.length === 0) {
      throw new Error('long state root did not produce a shipped v0.10.9 compatibility address');
    }
    const shippedSocketPath = shippedAddresses.paths[0];
    if (shippedSocketPath === undefined || shippedSocketPath === paths.socketPath) {
      throw new Error('shipped and current fallback addresses unexpectedly agree');
    }

    writeIncumbentDiscovery(shippedSocketPath);
    const methods: string[] = [];
    const requests: JsonRpcRequestEnvelope[] = [];
    await startIncumbent(shippedSocketPath, (request) => {
      methods.push(request.method);
      requests.push(request);
      if (request.method === 'transport.ping' || request.method === 'transport.health') {
        return { kind: 'response', id: request.id, result: incumbentHealth() };
      }
      return {
        kind: 'error',
        id: request.id,
        error: { code: -32601, message: 'Method not found' },
      };
    });

    const containment = await createProviderProxySetCommandOperations().contain({
      setIdentity: providerProxySetAddress,
      abandonWithoutAbsence: false,
    });
    const discardProviderOperation = createRecoveryQuarantineCommandOperations().discardProviderOperation;
    if (discardProviderOperation === undefined) throw new Error('discard command is not configured');
    const discard = await discardProviderOperation({
      key: 'unreadable-provider-operation',
      revision: `sha256:${'b'.repeat(64)}`,
    });

    expect(containment).toEqual({ kind: 'unsupported-coordinator', setIdentity: providerProxySetAddress });
    expect(discard).toEqual({
      kind: 'unsupported-coordinator',
      key: 'unreadable-provider-operation',
      revision: `sha256:${'b'.repeat(64)}`,
    });
    expect(methods).toContain('coordinator.provider_proxy_set.contain');
    expect(methods).toContain('coordinator.recovery_quarantine.discard_provider_operation');
    expect(requests).toContainEqual(
      expect.objectContaining({
        method: 'transport.health',
        auth: { kind: 'boot', token: 'incumbent-boot-token' },
      }),
    );
    expect(methods).not.toContain('transport.shutdown');
  });
});
