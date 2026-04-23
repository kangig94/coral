import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CoordinatorDiscoveryRecord } from '#src/coordinator/discovery-api.js';
import type { ActivationDeps } from '#src/expansion/activate.js';
import { installResponseSchema } from '#src/expansion/contracts.js';
import { installExpansion, uninstallExpansion } from '#src/expansion/install.js';
import { equipmentAddonPath, equipmentDataDir, equipmentInstallLockPath } from '#src/expansion/paths.js';
import { equip, info, list, unequip, update } from '#src/expansion/workflow.js';
import { documentedCoralSetupError } from '#src/runtime/errors.js';
import type { Runtime } from '#src/runtime/ports.js';
import type { ExecResult, StoragePort } from '#src/runtime/ports.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';
import type { IpcClient } from '#src/transport/ipc/client.js';
import type { EnsuredIpcClient } from '#src/transport/ipc/ensure.js';

const NEEDLE_VERSION = '0.2.0';
const CGC_VERSION = 'v1.2.3';

type MetaKind = 'canonical' | 'legacy';

type FakeCoordinatorCall = {
  channel: 'ensure' | 'passive';
  method: string;
  params: unknown;
  socketPath?: string;
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function createRuntime(env: Record<string, string> = {}): Runtime {
  const homeDir = env.HOME ?? '/tmp/coral-equip-test-home';
  const simulation = new SimulationRuntime({
    epochMs: Date.now(),
    env: {
      HOME: homeDir,
      USERPROFILE: homeDir,
      PATH: '/usr/bin',
      ...env,
    },
  });

  return {
    time: {
      now: () => Date.now(),
      sleep: (ms, options) =>
        new Promise<void>((resolve) => {
          const signal = options?.signal;
          if (signal?.aborted) {
            resolve();
            return;
          }
          const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
          }, ms);
          const onAbort = (): void => {
            clearTimeout(timer);
            resolve();
          };
          signal?.addEventListener('abort', onAbort, { once: true });
        }),
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (handle) => {
        if (handle) {
          clearTimeout(handle as NodeJS.Timeout);
        }
      },
      setInterval: (fn, ms) => setInterval(fn, ms),
      clearInterval: (handle) => {
        if (handle) {
          clearInterval(handle as NodeJS.Timeout);
        }
      },
    },
    storage: wrapStorage(simulation.storage),
    process: {
      spawn: simulation.process.spawn,
      exec: simulation.process.exec,
      execSync: (_command: string, _args: string[]) =>
        ({
          stdout: '',
          stderr: '',
          status: 1,
        }) satisfies ExecResult,
      kill: simulation.process.kill,
      isAlive: simulation.process.isAlive,
      durable: simulation.process.durable,
    },
    ids: simulation.ids,
    env: simulation.env,
    paths: simulation.paths,
  };
}

function wrapStorage(base: StoragePort, overrides: Partial<StoragePort> = {}): StoragePort {
  return {
    readFileSync: (...args) => overrides.readFileSync?.(...args) ?? base.readFileSync(...args),
    writeFileSync: (...args) => overrides.writeFileSync?.(...args) ?? base.writeFileSync(...args),
    renameSync: (...args) => overrides.renameSync?.(...args) ?? base.renameSync(...args),
    mkdirSync: (...args) => overrides.mkdirSync?.(...args) ?? base.mkdirSync(...args),
    rmSync: (...args) => overrides.rmSync?.(...args) ?? base.rmSync(...args),
    readdirSync: (...args) => overrides.readdirSync?.(...args) ?? base.readdirSync(...args),
    statSync: (...args) => overrides.statSync?.(...args) ?? base.statSync(...args),
    existsSync: (...args) => overrides.existsSync?.(...args) ?? base.existsSync(...args),
    openSync: (...args) => overrides.openSync?.(...args) ?? base.openSync(...args),
    readSync: (...args) => overrides.readSync?.(...args) ?? base.readSync(...args),
    closeSync: (...args) => overrides.closeSync?.(...args) ?? base.closeSync(...args),
    appendFileSync: (...args) => overrides.appendFileSync?.(...args) ?? base.appendFileSync(...args),
    appendFileDurableSync: (...args) =>
      overrides.appendFileDurableSync?.(...args) ?? base.appendFileDurableSync(...args),
    unlinkSync: (...args) => overrides.unlinkSync?.(...args) ?? base.unlinkSync(...args),
    tryExclusiveWriteSync: (...args) =>
      overrides.tryExclusiveWriteSync?.(...args) ?? base.tryExclusiveWriteSync(...args),
    writeAtomicSync: (...args) => overrides.writeAtomicSync?.(...args) ?? base.writeAtomicSync(...args),
    writeAtomicDurableSync: (...args) =>
      overrides.writeAtomicDurableSync?.(...args) ?? base.writeAtomicDurableSync(...args),
    chmodSync: (...args) => overrides.chmodSync?.(...args) ?? base.chmodSync(...args),
  };
}

function withStorageOverrides(runtime: Runtime, overrides: Partial<StoragePort>): Runtime {
  return {
    ...runtime,
    storage: wrapStorage(runtime.storage, overrides),
  };
}

function baseDir(runtime: Runtime): string {
  return join(runtime.env.homedir(), '.coral');
}

function envSnapshot(runtime: Runtime): Readonly<Record<string, string>> {
  return runtime.env.fullSnapshot();
}

function needleTargetDir(runtime: Runtime): string {
  return equipmentDataDir('needle', { baseDir: baseDir(runtime), env: envSnapshot(runtime) });
}

function needleAddon(runtime: Runtime): string {
  return equipmentAddonPath('needle', { baseDir: baseDir(runtime), env: envSnapshot(runtime) });
}

function needleLock(runtime: Runtime): string {
  return equipmentInstallLockPath('needle', { baseDir: baseDir(runtime), env: envSnapshot(runtime) });
}

function cgcBinaryPath(runtime: Runtime): string {
  return join(runtime.env.homedir(), '.claude', 'tools', runtime.env.platform() === 'win32' ? 'cgc.exe' : 'cgc');
}

function cgcMetaPath(runtime: Runtime): string {
  return join(runtime.env.homedir(), '.claude', 'tools', '.cgc.json');
}

function needleEnvPath(runtime: Runtime): string {
  return join(runtime.env.homedir(), '.coral', '.env');
}

function readBuffer(runtime: Runtime, path: string): Buffer {
  const stat = runtime.storage.statSync(path);
  const fd = runtime.storage.openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(stat.size);
    const bytesRead = runtime.storage.readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    runtime.storage.closeSync(fd);
  }
}

function writeTarString(header: Buffer, value: string, offset: number, length: number): void {
  Buffer.from(value, 'utf-8').copy(header, offset, 0, length);
}

function writeTarOctal(header: Buffer, value: number, offset: number, length: number): void {
  const encoded = `${value.toString(8).padStart(length - 1, '0')}\0`;
  Buffer.from(encoded, 'utf-8').copy(header, offset, 0, length);
}

function createPrebuildArchive(fileName: string, content: Buffer): Buffer {
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
  return gzipSync(Buffer.concat([header, content, Buffer.alloc(paddingSize, 0), Buffer.alloc(1024, 0)]));
}

function writeInstalledNeedle(
  runtime: Runtime,
  version: string = NEEDLE_VERSION,
  method: 'prebuild' | 'source-build' = 'prebuild',
  metaKind: MetaKind = 'canonical',
): void {
  const targetDir = needleTargetDir(runtime);
  runtime.storage.mkdirSync(targetDir, { recursive: true });
  runtime.storage.writeFileSync(needleAddon(runtime), Buffer.from('installed-addon'));
  runtime.storage.writeFileSync(
    join(targetDir, metaKind === 'canonical' ? '.needle-meta.json' : '.kb-meta.json'),
    JSON.stringify({ version, method }),
    { encoding: 'utf-8' },
  );
}

function writeInstalledCgc(runtime: Runtime, version: string = CGC_VERSION): void {
  runtime.storage.mkdirSync(dirname(cgcBinaryPath(runtime)), { recursive: true });
  runtime.storage.writeFileSync(cgcBinaryPath(runtime), Buffer.from('binary'));
  runtime.storage.writeFileSync(cgcMetaPath(runtime), JSON.stringify({ version, method: 'binary' }), {
    encoding: 'utf-8',
  });
}

function satisfyNeedleOnboarding(runtime: Runtime): void {
  const envPath = needleEnvPath(runtime);
  runtime.storage.mkdirSync(dirname(envPath), { recursive: true });
  runtime.storage.writeFileSync(
    envPath,
    'CORAL_EMBEDDING_PROVIDER=local-onnx\nCORAL_EMBEDDING_MODEL=nomic-embed-text\n',
    { encoding: 'utf-8' },
  );
}

function stubFetch(handler: (url: string) => Promise<Response> | Response): { calls: string[] } {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input);
      calls.push(url);
      return await handler(url);
    }),
  );
  return { calls };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function binaryResponse(value: Buffer): Response {
  return new Response(new Uint8Array(value), { status: 200 });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

function createErrnoError(code: string, path: string, message?: string): NodeJS.ErrnoException {
  const error = new Error(message ?? `${code}: ${path}`) as NodeJS.ErrnoException;
  error.code = code;
  error.path = path;
  return error;
}

function defaultDiscoveryRecord(): CoordinatorDiscoveryRecord {
  return {
    pid: 1234,
    port: 4312,
    socketPath: '/tmp/coral-passive.sock',
    bundleHash: 'bundle-a',
    flavor: 'prod',
    namespace: 'ns-a',
    startedAt: 1_713_456_789_000,
    token: 'token-a',
  };
}

function createActivationHarness(
  opts: {
    discovery?: CoordinatorDiscoveryRecord | null;
    passiveRequest?: (method: string, params: unknown) => Promise<unknown> | unknown;
    ensureRequest?: (method: string, params: unknown) => Promise<unknown> | unknown;
  } = {},
): { deps: ActivationDeps; calls: FakeCoordinatorCall[] } {
  const calls: FakeCoordinatorCall[] = [];
  const createPassiveClient = (socketPath: string): IpcClient => ({
    socketPath,
    request: async <TResult>(method: string, params?: unknown) => {
      calls.push({ channel: 'passive', method, params, socketPath });
      return (await Promise.resolve(opts.passiveRequest?.(method, params) ?? { equipment: [] })) as TResult;
    },
    subscribe: async () => {
      throw new Error('Subscriptions are not used in workflow.install.integration.test.ts');
    },
    health: async () => {
      throw new Error('Health checks are not used in workflow.install.integration.test.ts');
    },
    shutdown: async () => {
      throw new Error('Shutdown is not used in workflow.install.integration.test.ts');
    },
  });
  const createEnsuredClient = (): EnsuredIpcClient => ({
    ...createPassiveClient('/tmp/coral-passive.sock'),
    request: async <TResult>(method: string, params?: unknown) => {
      calls.push({ channel: 'ensure', method, params });
      return (await Promise.resolve(
        opts.ensureRequest?.(method, params) ?? {
          status: 'equipped',
          equipment: {
            slot: 'kb.vector',
            name: 'needle',
            status: 'equipped',
          },
        },
      )) as TResult;
    },
    instanceId: 'instance-a',
    bundleHash: 'bundle-a',
    flavor: 'prod',
    namespace: 'ns-a',
    host: '127.0.0.1',
    port: 4312,
    token: 'token-a',
    version: '0.5.2',
  });

  return {
    calls,
    deps: {
      readPassiveDiscovery: vi.fn(() => (opts.discovery === undefined ? defaultDiscoveryRecord() : opts.discovery)),
      ipcClientFactory: vi.fn((socketPath: string) => createPassiveClient(socketPath)),
      ensureClient: vi.fn(async () => createEnsuredClient()),
      resolveFlavor: vi.fn(() => 'prod' as const),
    },
  };
}

describe('expansion workflow/install integration (AC24)', () => {
  it('runs needle equip in-process, pauses for onboarding, then activates through the fake IPC client', async () => {
    const runtime = createRuntime();
    const addonBytes = Buffer.from('native-addon');
    const fetch = stubFetch(async (url) => {
      expect(url).toBe(
        `https://github.com/kangig94/coral-needle/releases/download/v${NEEDLE_VERSION}/coral-needle-v${NEEDLE_VERSION}-${runtime.env.platform()}-${process.arch === 'x64' ? 'amd64' : process.arch}.tar.gz`,
      );
      return binaryResponse(createPrebuildArchive('coral-needle.node', addonBytes));
    });
    const activation = createActivationHarness({
      ensureRequest: async () => ({
        status: 'equipped',
        equipment: {
          slot: 'kb.vector',
          name: 'needle',
          status: 'equipped',
        },
      }),
    });

    const first = installResponseSchema.parse(await equip('needle', { runtime, activation: activation.deps }));
    expect(first.status).toBe('installed');
    if (first.status !== 'installed') {
      throw new Error(`Expected installed, received ${first.status}`);
    }
    expect(first).toMatchObject({
      method: 'prebuild',
      targetDir: needleTargetDir(runtime),
      postInstall: ['register_equipment'],
      version: NEEDLE_VERSION,
      onboarding: {
        envPath: needleEnvPath(runtime),
        providerEnvKey: 'CORAL_EMBEDDING_PROVIDER',
        modelEnvKey: 'CORAL_EMBEDDING_MODEL',
        apiKeyEnvKey: 'CORAL_EMBEDDING_API_KEY',
        requiredEnv: [
          {
            provider: 'local-onnx',
            env: ['CORAL_EMBEDDING_PROVIDER', 'CORAL_EMBEDDING_MODEL'],
          },
          {
            provider: 'default',
            env: ['CORAL_EMBEDDING_PROVIDER', 'CORAL_EMBEDDING_API_KEY'],
          },
        ],
      },
    });
    expect(first.onboarding).toBeDefined();
    expect(first.onboarding?.choices).toEqual([
      {
        id: 'local-nomic-embed-text',
        label: 'Local model: nomic-embed-text',
        provider: 'local-onnx',
        model: 'nomic-embed-text',
        dims: 768,
      },
      {
        id: 'local-bge-m3',
        label: 'Local model: bge-m3',
        provider: 'local-onnx',
        model: 'bge-m3',
        dims: 1024,
      },
      {
        id: 'manual',
        label: 'Manual setup',
        provider: null,
        model: null,
        dims: null,
      },
    ]);
    expect(readBuffer(runtime, needleAddon(runtime))).toEqual(addonBytes);
    expect(runtime.storage.existsSync(`${needleAddon(runtime)}.part`)).toBe(false);
    expect(
      JSON.parse(runtime.storage.readFileSync(join(needleTargetDir(runtime), '.needle-meta.json'), 'utf-8')),
    ).toEqual({
      version: NEEDLE_VERSION,
      method: 'prebuild',
    });
    expect(activation.calls).toEqual([]);

    satisfyNeedleOnboarding(runtime);

    const second = installResponseSchema.parse(await equip('needle', { runtime, activation: activation.deps }));
    expect(second).toEqual({
      status: 'equipped',
      equipment: {
        slot: 'kb.vector',
        name: 'needle',
        status: 'equipped',
      },
    });
    expect(fetch.calls).toHaveLength(1);
    expect(activation.calls).toEqual([
      {
        channel: 'ensure',
        method: 'coordinator.registerEquipment',
        params: { name: 'needle' },
      },
    ]);
  });

  it('installs needle into the dev equipment dir when CORAL_FLAVOR=dev', async () => {
    const runtime = createRuntime({ CORAL_FLAVOR: 'dev' });
    const addonBytes = Buffer.from('native-addon-dev');
    stubFetch(async () => binaryResponse(createPrebuildArchive('coral-needle.node', addonBytes)));

    const result = installResponseSchema.parse(await installExpansion('needle', { runtime }));

    expect(result).toMatchObject({
      status: 'installed',
      method: 'prebuild',
      targetDir: needleTargetDir(runtime),
      postInstall: ['register_equipment'],
      version: NEEDLE_VERSION,
    });
    expect(readBuffer(runtime, needleAddon(runtime))).toEqual(addonBytes);
  });

  it('returns already_installed from runtime-local metadata and still honors the legacy kb meta file', async () => {
    const runtime = createRuntime();
    writeInstalledNeedle(runtime, NEEDLE_VERSION, 'source-build', 'legacy');
    const fetch = stubFetch(async () => {
      throw new Error('already_installed should not download');
    });

    const result = installResponseSchema.parse(await installExpansion('needle', { runtime }));

    expect(result).toMatchObject({
      status: 'already_installed',
      method: 'source-build',
      targetDir: needleTargetDir(runtime),
      postInstall: ['register_equipment'],
      version: NEEDLE_VERSION,
    });
    expect(fetch.calls).toEqual([]);
  });

  it('returns updated when an older local needle install is replaced in-process', async () => {
    const runtime = createRuntime();
    writeInstalledNeedle(runtime, '0.1.0');
    const addonBytes = Buffer.from('updated-addon');
    stubFetch(async () => binaryResponse(createPrebuildArchive('coral-needle.node', addonBytes)));

    const result = installResponseSchema.parse(await installExpansion('needle', { runtime }));

    expect(result).toMatchObject({
      status: 'updated',
      method: 'prebuild',
      targetDir: needleTargetDir(runtime),
      postInstall: ['register_equipment'],
      version: NEEDLE_VERSION,
    });
    expect(readBuffer(runtime, needleAddon(runtime))).toEqual(addonBytes);
  });

  it.skipIf(process.arch !== 'x64')(
    'returns already_up_to_date from workflow.update() for install-only expansions without activation',
    async () => {
      const runtime = createRuntime();
      writeInstalledCgc(runtime, CGC_VERSION);
      const activation = createActivationHarness();
      const fetch = stubFetch(async (url) => {
        expect(url).toBe('https://api.github.com/repos/CodeGraphContext/CodeGraphContext/releases/latest');
        return jsonResponse({ tag_name: CGC_VERSION });
      });

      const result = installResponseSchema.parse(await update('cgc', { runtime, activation: activation.deps }));

      expect(result).toEqual({
        status: 'already_up_to_date',
        method: 'binary',
        version: CGC_VERSION,
        command: cgcBinaryPath(runtime),
      });
      expect(fetch.calls).toHaveLength(1);
      expect(activation.calls).toEqual([]);
    },
  );

  it.skipIf(process.arch !== 'x64')(
    'returns install-only equip results unchanged without coordinator activation attempts',
    async () => {
      const runtime = createRuntime();
      const activation = createActivationHarness();
      const binaryBytes = Buffer.from('#!/bin/sh\necho cgc\n');
      const fetch = stubFetch(async (url) => {
        if (url === 'https://api.github.com/repos/CodeGraphContext/CodeGraphContext/releases/latest') {
          return jsonResponse({ tag_name: CGC_VERSION });
        }
        expect(url).toBe(
          `https://github.com/CodeGraphContext/CodeGraphContext/releases/download/${CGC_VERSION}/cgc-linux-x64`,
        );
        return binaryResponse(binaryBytes);
      });

      const result = installResponseSchema.parse(await equip('cgc', { runtime, activation: activation.deps }));

      expect(result).toEqual({
        status: 'installed',
        method: 'binary',
        version: CGC_VERSION,
        command: cgcBinaryPath(runtime),
      });
      expect(readBuffer(runtime, cgcBinaryPath(runtime))).toEqual(binaryBytes);
      expect(fetch.calls).toHaveLength(2);
      expect(activation.calls).toEqual([]);
    },
  );

  it('reports install-only lock state via workflow.info() without touching coordinator IPC', async () => {
    const runtime = createRuntime();
    const activation = createActivationHarness();
    runtime.storage.mkdirSync(
      equipmentInstallLockPath('cgc', { baseDir: baseDir(runtime), env: envSnapshot(runtime) }),
      {
        recursive: true,
      },
    );

    const result = installResponseSchema.parse(await info('cgc', { runtime, activation: activation.deps }));

    expect(result).toEqual({
      status: 'info',
      package: expect.objectContaining({
        id: 'cgc',
        activation: 'none',
        status: 'installing',
      }),
    });
    expect(activation.calls).toEqual([]);
  });

  it('lists installed packages in-process and merges passive coordinator state', async () => {
    const runtime = createRuntime();
    writeInstalledNeedle(runtime);
    writeInstalledCgc(runtime);
    const activation = createActivationHarness({
      passiveRequest: async (method) => {
        expect(method).toBe('coordinator.listEquipment');
        return {
          equipment: [
            {
              slot: 'kb.vector',
              name: 'needle',
              status: 'catching_up',
            },
          ],
        };
      },
    });

    const result = installResponseSchema.parse(await list({ runtime, activation: activation.deps }));

    expect(result).toEqual({
      status: 'catalog',
      packages: expect.arrayContaining([
        expect.objectContaining({
          id: 'needle',
          activation: 'equipment',
          status: 'catching_up',
          version: NEEDLE_VERSION,
          addonPath: needleAddon(runtime),
        }),
        expect.objectContaining({
          id: 'cgc',
          activation: 'none',
          status: 'installed',
          version: CGC_VERSION,
        }),
      ]),
    });
    expect(activation.calls).toEqual([
      {
        channel: 'passive',
        method: 'coordinator.listEquipment',
        params: {},
        socketPath: '/tmp/coral-passive.sock',
      },
    ]);
  });

  it('reports equipment info directly from the workflow API without subprocess IPC wrappers', async () => {
    const runtime = createRuntime();
    writeInstalledNeedle(runtime);
    const activation = createActivationHarness({
      passiveRequest: async () => ({
        equipment: [
          {
            slot: 'kb.vector',
            name: 'needle',
            status: 'inactive',
          },
        ],
      }),
    });

    const result = installResponseSchema.parse(await info('needle', { runtime, activation: activation.deps }));

    expect(result).toEqual({
      status: 'info',
      package: expect.objectContaining({
        id: 'needle',
        activation: 'equipment',
        status: 'inactive',
        version: NEEDLE_VERSION,
        addonPath: needleAddon(runtime),
      }),
    });
  });

  it('keeps install-only state readable when passive coordinator discovery is unavailable', async () => {
    const runtime = createRuntime();
    writeInstalledNeedle(runtime);
    writeInstalledCgc(runtime);
    const activation = createActivationHarness({ discovery: null });

    const result = installResponseSchema.parse(await list({ runtime, activation: activation.deps }));

    expect(result).toEqual({
      status: 'catalog',
      packages: expect.arrayContaining([
        expect.objectContaining({
          id: 'needle',
          activation: 'equipment',
          status: 'inactive',
        }),
        expect.objectContaining({
          id: 'cgc',
          activation: 'none',
          status: 'installed',
        }),
      ]),
    });
    expect(activation.calls).toEqual([]);
  });

  it('returns structured unknown_equipment errors from the workflow API', async () => {
    const runtime = createRuntime();

    const result = installResponseSchema.parse(await info('missing-package', { runtime }));

    expect(result).toMatchObject({
      status: 'error',
      code: 'unknown_equipment',
      context: { name: 'missing-package' },
    });
  });

  it('reports equipment_install_lock_contended while another install holds the runtime lock', async () => {
    const runtime = createRuntime();
    const gate = deferred<void>();
    const started = deferred<void>();
    stubFetch(async () => {
      started.resolve();
      await gate.promise;
      return binaryResponse(createPrebuildArchive('coral-needle.node', Buffer.from('locked-addon')));
    });

    const firstInstall = installExpansion('needle', { runtime, lockTimeoutMs: 25 });
    await started.promise;

    const secondInstall = installResponseSchema.parse(await installExpansion('needle', { runtime, lockTimeoutMs: 25 }));
    gate.resolve();

    expect(secondInstall).toMatchObject({
      status: 'error',
      code: 'equipment_install_lock_contended',
      context: { name: 'needle' },
    });
    expect((await firstInstall).status).toBe('installed');
    expect(runtime.storage.existsSync(needleLock(runtime))).toBe(false);
  });

  it('encodes unwritable install paths as equipment_install_path_unwritable', async () => {
    const baseRuntime = createRuntime();
    const runtime = withStorageOverrides(baseRuntime, {
      writeFileSync: (path, data, options) => {
        if (path.startsWith(needleTargetDir(baseRuntime))) {
          throw createErrnoError('EACCES', path);
        }
        return baseRuntime.storage.writeFileSync(path, data, options);
      },
    });
    stubFetch(async () => binaryResponse(createPrebuildArchive('coral-needle.node', Buffer.from('blocked'))));

    const result = installResponseSchema.parse(await installExpansion('needle', { runtime }));

    expect(result).toMatchObject({
      status: 'error',
      code: 'equipment_install_path_unwritable',
      context: { name: 'needle' },
    });
  });

  it('surfaces structured coordinator failures through workflow.equip() without a coordinator subprocess', async () => {
    const runtime = createRuntime();
    writeInstalledNeedle(runtime);
    satisfyNeedleOnboarding(runtime);
    const activation = createActivationHarness({
      ensureRequest: async () => {
        throw documentedCoralSetupError('equipment_install_lock_contended', { name: 'needle' });
      },
    });

    const result = installResponseSchema.parse(await equip('needle', { runtime, activation: activation.deps }));

    expect(result).toMatchObject({
      status: 'error',
      code: 'equipment_install_lock_contended',
      userMessage: 'Another coral-cli expansion equip is in progress for needle.',
      remediation: 'Wait for the in-flight install to complete or remove the stale lock file.',
      context: { name: 'needle' },
    });
  });

  it('unequips live equipment in-process, unregisters through the fake IPC client, and removes local artifacts', async () => {
    const runtime = createRuntime();
    writeInstalledNeedle(runtime);
    const activation = createActivationHarness({
      passiveRequest: async () => ({
        equipment: [
          {
            slot: 'kb.vector',
            name: 'needle',
            status: 'equipped',
          },
        ],
      }),
      ensureRequest: async (method) => {
        expect(method).toBe('coordinator.unregisterEquipment');
        return { status: 'uninstalled' };
      },
    });

    const result = installResponseSchema.parse(await unequip('needle', { runtime, activation: activation.deps }));

    expect(result).toEqual({ status: 'uninstalled' });
    expect(runtime.storage.existsSync(needleTargetDir(runtime))).toBe(false);
    expect(activation.calls).toEqual([
      {
        channel: 'passive',
        method: 'coordinator.listEquipment',
        params: {},
        socketPath: '/tmp/coral-passive.sock',
      },
      {
        channel: 'ensure',
        method: 'coordinator.unregisterEquipment',
        params: { name: 'needle' },
      },
    ]);
  });

  it('treats unequip as idempotent when the runtime has no local install state', async () => {
    const runtime = createRuntime();
    const activation = createActivationHarness({
      passiveRequest: async () => ({
        equipment: [
          {
            slot: 'kb.vector',
            name: 'needle',
            status: 'inactive',
          },
        ],
      }),
    });

    const result = installResponseSchema.parse(await unequip('needle', { runtime, activation: activation.deps }));

    expect(result).toEqual({ status: 'not_equipped' });
    expect(activation.calls).toEqual([
      {
        channel: 'passive',
        method: 'coordinator.listEquipment',
        params: {},
        socketPath: '/tmp/coral-passive.sock',
      },
    ]);
  });

  it('exposes uninstallExpansion() directly for not_equipped cleanup without subprocess wrappers', async () => {
    const runtime = createRuntime();

    const result = installResponseSchema.parse(await uninstallExpansion('needle', { runtime }));

    expect(result).toEqual({ status: 'not_equipped' });
  });
});
