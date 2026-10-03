import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createRealRuntime } from '#src/runtime/real.js';
import { createProviderBootstrapCapsule } from '#src/provider-proxy/bootstrap-capsule.js';
import { startProviderReaperRole } from '#src/provider-proxy/role-main.js';
import { connectControlClient } from '#src/provider-proxy/control-client.js';
import { DEFAULT_PROVIDER_PROXY_ORPHAN_TIMEOUT_MS } from '#src/provider-proxy/orphan-deadline.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'coral-reaper-startup-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const runtime = createRealRuntime('prod', { baseDir: root });
  const socket = join(root, 'reaper.sock');
  const buildSetId = '44444444-4444-4444-8444-444444444444';
  const secret = 'c'.repeat(64);
  const capsulePath = join(root, 'reaper.json');
  createProviderBootstrapCapsule(
    capsulePath,
    {
      role: 'reaper',
      generation: 'gen2',
      flavor: 'prod',
      buildSetId,
      hostFingerprint: 'a'.repeat(64),
      guardianInstanceId: '11111111-1111-4111-8111-111111111111',
      reaperInstanceId: '22222222-2222-4222-8222-222222222222',
      proxyInstanceId: '33333333-3333-4333-8333-333333333333',
      bootstrapNonce: 'b'.repeat(64),
      canonicalControlEndpoint: socket,
      guardianControlEndpoint: join(root, 'guardian.sock'),
      proxyEndpoint: join(root, 'proxy.sock'),
      guardianReaperAuthSecret: secret,
    },
    { storage: runtime.storage, uid: process.getuid!() },
  );
  const schedule = runtime.time.setTimeout.bind(runtime.time);
  let startupWake: (() => void) | undefined;
  let startupTimer: ReturnType<typeof schedule> | undefined;
  vi.spyOn(runtime.time, 'setTimeout').mockImplementation((callback, ms) => {
    const handle = schedule(callback, ms);
    if (ms === DEFAULT_PROVIDER_PROXY_ORPHAN_TIMEOUT_MS) {
      startupWake = callback;
      startupTimer = handle;
    }
    return handle;
  });
  const clear = vi.spyOn(runtime.time, 'clearTimeout');
  const kill = vi.spyOn(runtime.process, 'kill');
  const mint = vi.spyOn(runtime.ids, 'uuid');
  const exit = vi.fn();
  const role = await startProviderReaperRole(capsulePath, {
    runtime,
    pluginRoot: root,
    baseDir: root,
    resolveStrictIdentity: () => ({
      ok: true,
      manifest: {
        version: '1.0.0',
        buildSetId,
        flavor: 'prod',
        storeFormatFingerprint: `sha256:${'e'.repeat(64)}`,
        bundleHash: '1'.repeat(16),
        cliBundleHash: '2'.repeat(16),
        claudeAppserverBundleHash: '3'.repeat(16),
        durableWrapperBundleHash: '4'.repeat(16),
      },
    }),
    readProcessIncarnation: () => testIncarnation(5000),
    exitProcess: exit,
  });
  cleanups.push(role.close);
  return {
    socket,
    role,
    exit,
    kill,
    mint,
    clear,
    startupTimer: () => startupTimer,
    wake: () => {
      expect(startupWake).toBeDefined();
      if (startupTimer !== undefined) runtime.time.clearTimeout(startupTimer);
      startupWake?.();
    },
    pair: async () => {
      const client = await connectControlClient(
        socket,
        {
          setTimeout,
          clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
        },
        1000,
      );
      cleanups.push(() => client.close());
      const result = await client.exchange('reaper.pair.v1', { pairingSecret: secret }, 1000);
      expect(result).toMatchObject({ kind: 'response', response: { kind: 'result', value: { state: 'paired' } } });
      return client;
    },
  };
}

it('closes and exits an unrecorded reaper when its paired guardian disconnects', async () => {
  const f = await fixture();
  const client = await f.pair();
  client.close();
  await vi.waitFor(() => expect(f.exit).toHaveBeenCalledWith(0));
  expect(existsSync(f.socket)).toBe(false);
  expect(f.role.reaper.enforcer()).toBeNull();
  expect(f.kill).not.toHaveBeenCalled();
  expect(f.mint).not.toHaveBeenCalled();
});

it.each([false, true])('bounds unrecorded startup, paired: %s', async (paired) => {
  const f = await fixture();
  if (paired) await f.pair();
  f.wake();
  await vi.waitFor(() => expect(f.exit).toHaveBeenCalledWith(0));
  expect(existsSync(f.socket)).toBe(false);
  expect(f.role.reaper.enforcer()).toBeNull();
  expect(f.kill).not.toHaveBeenCalled();
  expect(f.mint).not.toHaveBeenCalled();
});

it('cancels startup exit when containment is recorded, even if the wake was already queued', async () => {
  const f = await fixture();
  const client = await f.pair();
  const result = await client.exchange(
    'reaper.record-containment.v1',
    {
      pid: 5100,
      incarnation: testIncarnation(900),
      processGroupId: 5100,
      containmentKind: 'posix-group',
    },
    1000,
  );
  expect(result).toMatchObject({
    kind: 'response',
    response: { kind: 'result', value: { state: 'containment-recorded' } },
  });
  expect(f.clear).toHaveBeenCalledWith(f.startupTimer());
  f.wake();
  client.close();
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  expect(f.exit).not.toHaveBeenCalled();
  expect(f.role.reaper.enforcer()).not.toBeNull();
  expect(existsSync(f.socket)).toBe(true);
  expect(f.kill).not.toHaveBeenCalled();
});

it('refuses containment recording after startup exit has been decided', async () => {
  const f = await fixture();
  const client = await f.pair();
  f.wake();
  const result = await client.exchange(
    'reaper.record-containment.v1',
    {
      pid: 5100,
      incarnation: testIncarnation(900),
      processGroupId: 5100,
      containmentKind: 'posix-group',
    },
    1000,
  );
  expect(result).not.toMatchObject({ kind: 'response', response: { kind: 'result' } });
  await vi.waitFor(() => expect(f.exit).toHaveBeenCalledWith(0));
  expect(f.role.reaper.enforcer()).toBeNull();
  expect(f.kill).not.toHaveBeenCalled();
  expect(f.mint).not.toHaveBeenCalled();
});
