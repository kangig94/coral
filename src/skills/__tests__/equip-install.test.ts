import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { equipmentAddonPath, equipmentDataDir, equipmentInstallLockPath } from '../../infra/equipment-paths.js';

const INSTALL_SCRIPT = join(process.cwd(), 'skills', 'equip', 'install.mjs');
const COORDINATOR_CLIENT_SCRIPT = join(process.cwd(), 'skills', 'equip', 'coordinator-client.mjs');
const NEEDLE_VERSION = '0.2.0';
const RETIRED_VECTOR_DIR_NAME = ['v', 'e', 'c'].join('');
const createdRoots: string[] = [];

interface InstallerChoice {
  id: string;
  label: string;
  provider: string | null;
  model: string | null;
  dims: number | null;
}

interface RequiredEnvRule {
  provider: string;
  env: string[];
}

interface CatalogPackage {
  id: string;
  name: string;
  description: string;
  status?: string;
  statusDescription?: string;
}

interface InstallerJson {
  status: string;
  method?: string;
  targetDir?: string;
  postInstall?: string[];
  version?: string;
  name?: string;
  packages?: CatalogPackage[];
  equipment?: Array<{ slot: string; name: string; status: string }>;
  onboarding?: {
    envPath?: string;
    requiredEnv?: RequiredEnvRule[];
    providerEnvKey?: string;
    modelEnvKey?: string;
    apiKeyEnvKey?: string;
    securityNotice?: string;
    localRuntime?: {
      targetDir?: string;
      bootstrapPackageJson?: boolean;
      packageManager?: string;
      packageName?: string;
    };
    choices?: InstallerChoice[];
  };
  code?: string;
  userMessage?: string;
  remediation?: string;
  context?: Record<string, unknown>;
  suggestions?: string[];
}

interface Fixture {
  root: string;
  homeDir: string;
  coralBaseDir: string;
  binDir: string;
  logPath: string;
  archivePath: string;
  targetDir: string;
  runtimeDir: string;
}

interface FakeCoordinatorCall {
  method: string;
  params: unknown;
}

interface FakeCoordinatorResponse {
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

afterEach(() => {
  for (const root of createdRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function createFixture(): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'coral-equip-install-')));
  const fixture = {
    root,
    homeDir: join(root, 'home'),
    coralBaseDir: join(root, 'home', '.coral'),
    binDir: join(root, 'bin'),
    logPath: join(root, 'curl.log'),
    archivePath: join(root, 'prebuild.tar.gz'),
    targetDir: equipmentDataDir('needle', { baseDir: join(root, 'home', '.coral') }),
    runtimeDir: join(root, 'home', '.coral', 'data', 'kb'),
  };

  createdRoots.push(root);
  mkdirSync(fixture.homeDir, { recursive: true });
  mkdirSync(fixture.binDir, { recursive: true });
  return fixture;
}

function writeExecutable(path: string, body: string): void {
  writeFileSync(path, body, 'utf-8');
  chmodSync(path, 0o755);
}

function writeFakeCurl(binDir: string): void {
  writeExecutable(
    join(binDir, 'curl'),
    `#!/bin/sh
echo "$*" >> "$FAKE_CURL_LOG"
dest=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-o" ]; then
    dest="$2"
    shift 2
    continue
  fi
  shift
done
if [ "\${FAKE_CURL_FAIL:-0}" = "1" ]; then
  echo "forced curl failure" >&2
  exit 1
fi
if [ -z "$dest" ]; then
  echo "missing -o" >&2
  exit 1
fi
cp "$FAKE_CURL_ARCHIVE" "$dest"
`,
  );
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

function writeInstalledNeedle(
  fixture: Fixture,
  version: string = NEEDLE_VERSION,
  method: 'prebuild' | 'source-build' = 'prebuild',
  metaKind: 'canonical' | 'legacy' = 'canonical',
): void {
  mkdirSync(fixture.targetDir, { recursive: true });
  writeFileSync(join(fixture.targetDir, 'coral-needle.node'), Buffer.from('installed-addon'));
  writeFileSync(
    join(fixture.targetDir, metaKind === 'canonical' ? '.needle-meta.json' : '.kb-meta.json'),
    JSON.stringify({ version, method }),
    'utf-8',
  );
}

function writeGlobalNeedleMeta(fixture: Fixture, version: string): void {
  const toolsDir = join(fixture.homeDir, '.claude', 'tools');
  mkdirSync(toolsDir, { recursive: true });
  writeFileSync(join(toolsDir, '.needle.json'), JSON.stringify({ version, method: 'binary' }), 'utf-8');
}

async function runNodeScript(
  fixture: Fixture,
  scriptPath: string,
  args: string[],
  envOverrides: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string; status: number }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: fixture.homeDir,
        CLAUDE_PLUGIN_ROOT: fixture.root,
        PATH: `${fixture.binDir}:${process.env.PATH ?? ''}`,
        FAKE_CURL_LOG: fixture.logPath,
        FAKE_CURL_ARCHIVE: fixture.archivePath,
        ...envOverrides,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Timed out waiting for ${scriptPath}`));
    }, 5_000);
    timer.unref?.();

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf-8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf-8');
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({
        stdout,
        stderr,
        status: code ?? 1,
      });
    });
  });
}

async function runInstall(
  fixture: Fixture,
  args: string[],
  envOverrides: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string; status: number }> {
  return await runNodeScript(fixture, INSTALL_SCRIPT, args, envOverrides);
}

async function runCoordinatorClient(
  fixture: Fixture,
  args: string[],
  envOverrides: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string; status: number }> {
  return await runNodeScript(fixture, COORDINATOR_CLIENT_SCRIPT, args, envOverrides);
}

function parseResult<T extends InstallerJson>(result: { stdout: string; stderr: string; status: number }): T {
  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
  const trimmed = result.stdout.trim();
  expect(trimmed).not.toBe('');
  expect(trimmed.split(/\r?\n/)).toHaveLength(1);
  return JSON.parse(trimmed) as T;
}

function parseErrorResult<T extends InstallerJson>(result: { stdout: string; stderr: string; status: number }): T {
  expect(result.status).toBe(1);
  expect(result.stderr).toBe('');
  const trimmed = result.stdout.trim();
  expect(trimmed).not.toBe('');
  expect(trimmed.split(/\r?\n/)).toHaveLength(1);
  return JSON.parse(trimmed) as T;
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
}

function readLog(path: string): string[] {
  try {
    return readFileSync(path, 'utf-8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

function writeCoordinatorDiscovery(fixture: Fixture, socketPath: string): void {
  for (const runDir of [join(fixture.coralBaseDir, 'run'), join(fixture.coralBaseDir, 'run-dev')]) {
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'coordinator.json'), JSON.stringify({ socketPath }), 'utf-8');
  }
}

async function startFakeCoordinator(
  fixture: Fixture,
  handler: (request: { method: string; params: unknown }) => FakeCoordinatorResponse,
): Promise<{ calls: FakeCoordinatorCall[]; close(): Promise<void> }> {
  const socketPath = join(fixture.root, 'coordinator.sock');
  const calls: FakeCoordinatorCall[] = [];
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

        const request = JSON.parse(frame) as { id: number | string; method: string; params?: unknown };
        calls.push({
          method: request.method,
          params: request.params,
        });

        const response = handler({
          method: request.method,
          params: request.params,
        });

        if (response.error) {
          socket.end(JSON.stringify({
            kind: 'error',
            id: request.id,
            error: response.error,
          }) + '\n');
          continue;
        }

        socket.end(JSON.stringify({
          kind: 'response',
          id: request.id,
          result: response.result,
        }) + '\n');
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => resolve());
  });
  writeCoordinatorDiscovery(fixture, socketPath);

  return {
    calls,
    close: async () => {
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

function findCatalogPackage(result: InstallerJson, id: string): CatalogPackage {
  const entry = result.packages?.find((item) => item.id === id);
  expect(entry).toBeDefined();
  return entry as CatalogPackage;
}

function resolveRequiredEnvForProvider(
  onboarding: NonNullable<InstallerJson['onboarding']>,
  provider: string,
): string[] {
  const matchedRule = onboarding.requiredEnv?.find((rule) => rule.provider === provider)
    ?? onboarding.requiredEnv?.find((rule) => rule.provider === 'default');
  expect(matchedRule).toBeDefined();
  return [...(matchedRule as RequiredEnvRule).env];
}

function isOnboardingSatisfied(
  onboarding: NonNullable<InstallerJson['onboarding']>,
  provider: string,
  env: Record<string, string>,
): boolean {
  const requiredEnv = resolveRequiredEnvForProvider(onboarding, provider);
  return requiredEnv.every((key) => {
    const value = env[key];
    return typeof value === 'string' && value.trim().length > 0;
  });
}

describe('skills/equip/install.mjs needle flow', () => {
  it('keeps the JS helper seam aligned with the TypeScript equipment path helpers', async () => {
    const fixture = createFixture();
    const jsPaths = await import(new URL('../../../skills/equip/equipment-paths.mjs', import.meta.url).href);
    const devEnv: NodeJS.ProcessEnv = { CORAL_FLAVOR: 'dev' };

    expect(jsPaths.equipmentDataDir('needle', { baseDir: fixture.coralBaseDir })).toBe(
      equipmentDataDir('needle', { baseDir: fixture.coralBaseDir }),
    );
    expect(jsPaths.equipmentAddonPath('needle', { baseDir: fixture.coralBaseDir })).toBe(
      equipmentAddonPath('needle', { baseDir: fixture.coralBaseDir }),
    );
    expect(jsPaths.equipmentInstallLockPath('needle', { baseDir: fixture.coralBaseDir })).toBe(
      equipmentInstallLockPath('needle', { baseDir: fixture.coralBaseDir }),
    );
    expect(jsPaths.equipmentDataDir('needle', { baseDir: fixture.coralBaseDir, env: devEnv })).toBe(
      equipmentDataDir('needle', { baseDir: fixture.coralBaseDir, env: devEnv }),
    );
    expect(jsPaths.equipmentDataDir('needle', { baseDir: fixture.coralBaseDir, env: devEnv })).toBe(
      join(fixture.coralBaseDir, 'data-dev', 'equipment', 'needle'),
    );
  });

  it('installs needle into the canonical equipment dir and emits register_equipment post-install JSON', async () => {
    const fixture = createFixture();
    const addonBytes = Buffer.from('native-addon');
    writeFakeCurl(fixture.binDir);
    createPrebuildArchive(fixture.archivePath, 'coral-needle.node', addonBytes);

    const result = parseResult(await runInstall(fixture, ['needle']));

    expect(result).toMatchObject({
      status: 'installed',
      method: 'prebuild',
      targetDir: fixture.targetDir,
      postInstall: ['register_equipment'],
      version: NEEDLE_VERSION,
      onboarding: {
        envPath: join(fixture.homeDir, '.coral', '.env'),
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
        providerEnvKey: 'CORAL_EMBEDDING_PROVIDER',
        modelEnvKey: 'CORAL_EMBEDDING_MODEL',
        apiKeyEnvKey: 'CORAL_EMBEDDING_API_KEY',
        securityNotice: 'Store CORAL_EMBEDDING_API_KEY in ~/.coral/.env directly, NOT in settings.json.',
        localRuntime: {
          targetDir: fixture.runtimeDir,
          bootstrapPackageJson: true,
          packageManager: 'npm',
          packageName: 'onnxruntime-node',
        },
      },
    });
    expect(result.onboarding?.choices).toEqual([
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
    expect(readFileSync(join(fixture.targetDir, 'coral-needle.node'))).toEqual(addonBytes);
    expect(existsSync(join(fixture.targetDir, 'coral-needle.node.part'))).toBe(false);
    expect(existsSync(join(fixture.targetDir, RETIRED_VECTOR_DIR_NAME))).toBe(false);
    expect(readJson(join(fixture.targetDir, '.needle-meta.json'))).toEqual({
      version: NEEDLE_VERSION,
      method: 'prebuild',
    });
    expect(existsSync(join(fixture.targetDir, '.kb-meta.json'))).toBe(false);
    const [curlCall] = readLog(fixture.logPath);
    expect(curlCall).toContain('-fsSL -o');
    expect(curlCall).toContain(
      `https://github.com/kangig94/coral-needle/releases/download/v${NEEDLE_VERSION}/coral-needle-v${NEEDLE_VERSION}-${process.platform}-${process.arch === 'x64' ? 'amd64' : process.arch}.tar.gz`,
    );
  });

  it('emits provider-aware onboarding requirements so local setup completes without an API key', async () => {
    const fixture = createFixture();
    writeFakeCurl(fixture.binDir);
    createPrebuildArchive(fixture.archivePath, 'coral-needle.node', Buffer.from('native-addon'));

    const result = parseResult(await runInstall(fixture, ['needle']));
    const onboarding = result.onboarding as NonNullable<InstallerJson['onboarding']>;

    expect(resolveRequiredEnvForProvider(onboarding, 'local-onnx')).toEqual([
      'CORAL_EMBEDDING_PROVIDER',
      'CORAL_EMBEDDING_MODEL',
    ]);
    expect(resolveRequiredEnvForProvider(onboarding, 'gemini')).toEqual([
      'CORAL_EMBEDDING_PROVIDER',
      'CORAL_EMBEDDING_API_KEY',
    ]);
    expect(resolveRequiredEnvForProvider(onboarding, 'openai-compatible')).toEqual([
      'CORAL_EMBEDDING_PROVIDER',
      'CORAL_EMBEDDING_API_KEY',
    ]);

    expect(isOnboardingSatisfied(onboarding, 'local-onnx', {
      CORAL_EMBEDDING_PROVIDER: 'local-onnx',
      CORAL_EMBEDDING_MODEL: 'nomic-embed-text',
    })).toBe(true);
    expect(isOnboardingSatisfied(onboarding, 'local-onnx', {
      CORAL_EMBEDDING_PROVIDER: 'local-onnx',
    })).toBe(false);
    expect(isOnboardingSatisfied(onboarding, 'gemini', {
      CORAL_EMBEDDING_PROVIDER: 'gemini',
    })).toBe(false);
    expect(isOnboardingSatisfied(onboarding, 'gemini', {
      CORAL_EMBEDDING_PROVIDER: 'gemini',
      CORAL_EMBEDDING_API_KEY: 'secret',
    })).toBe(true);
  });

  it('installs needle into the dev equipment dir when CORAL_FLAVOR=dev', async () => {
    const fixture = createFixture();
    const addonBytes = Buffer.from('native-addon-dev');
    const devTargetDir = equipmentDataDir('needle', {
      baseDir: fixture.coralBaseDir,
      env: { CORAL_FLAVOR: 'dev' },
    });
    writeFakeCurl(fixture.binDir);
    createPrebuildArchive(fixture.archivePath, 'coral-needle.node', addonBytes);

    const result = parseResult(await runInstall(fixture, ['needle'], { CORAL_FLAVOR: 'dev' }));

    expect(result).toMatchObject({
      status: 'installed',
      method: 'prebuild',
      targetDir: devTargetDir,
      postInstall: ['register_equipment'],
      version: NEEDLE_VERSION,
    });
    expect(readFileSync(join(devTargetDir, 'coral-needle.node'))).toEqual(addonBytes);
    expect(existsSync(fixture.targetDir)).toBe(false);
  });

  it('uses runtime-local needle metadata for already_installed and still reads the legacy kb meta file', async () => {
    const fixture = createFixture();
    writeGlobalNeedleMeta(fixture, '999.0.0');
    writeInstalledNeedle(fixture, NEEDLE_VERSION, 'source-build', 'legacy');

    const result = parseResult(await runInstall(fixture, ['needle']));

    expect(result).toMatchObject({
      status: 'already_installed',
      method: 'source-build',
      targetDir: fixture.targetDir,
      postInstall: ['register_equipment'],
      version: NEEDLE_VERSION,
      onboarding: {
        localRuntime: {
          targetDir: fixture.runtimeDir,
        },
      },
    });
    expect(readLog(fixture.logPath)).toEqual([]);
  });

  it('returns already_up_to_date when the runtime-local addon already matches the packaged needleVersion', async () => {
    const fixture = createFixture();
    writeInstalledNeedle(fixture, NEEDLE_VERSION, 'prebuild');

    const result = parseResult(await runInstall(fixture, ['--update', 'needle']));

    expect(result).toMatchObject({
      status: 'already_up_to_date',
      method: 'prebuild',
      targetDir: fixture.targetDir,
      postInstall: ['register_equipment'],
      version: NEEDLE_VERSION,
    });
    expect(readLog(fixture.logPath)).toEqual([]);
  });

  it('reports install lock contention through the structured equipment error shape', async () => {
    const fixture = createFixture();
    const lockPath = equipmentInstallLockPath('needle', { baseDir: fixture.coralBaseDir });
    mkdirSync(lockPath, { recursive: true });

    const result = parseErrorResult(await runInstall(fixture, ['needle']));

    expect(result).toMatchObject({
      status: 'error',
      code: 'equipment_install_lock_contended',
      userMessage: 'Another /equip is in progress for needle.',
      remediation: 'Wait for the in-flight install to complete or remove the stale lock file.',
    });
  });

  it('suggests a concrete next step when uninstall is missing an equipment name', async () => {
    const fixture = createFixture();

    const result = parseErrorResult(await runInstall(fixture, ['uninstall']));

    expect(result).toEqual({
      status: 'error',
      message: 'uninstall requires a package name',
      suggestions: ["Use '/equip uninstall needle'."],
    });
  });

  it('suggests a concrete next step when --update is missing a package name', async () => {
    const fixture = createFixture();

    const result = parseErrorResult(await runInstall(fixture, ['--update']));

    expect(result).toEqual({
      status: 'error',
      message: '--update requires a package name',
      suggestions: ["Use '/equip --update needle'."],
    });
  });

  it('suggests listing the catalog for unknown packages', async () => {
    const fixture = createFixture();

    const result = parseErrorResult(await runInstall(fixture, ['unknown-package']));

    expect(result).toEqual({
      status: 'error',
      message: 'Unknown package unknown-package',
      suggestions: ["Run '/equip --list' to see available packages."],
    });
  });

  it('routes register_equipment through the standalone coordinator IPC helper', async () => {
    const fixture = createFixture();
    const coordinator = await startFakeCoordinator(fixture, () => ({
      result: {
        status: 'catching_up',
        equipment: {
          slot: 'kb.vector',
          name: 'needle',
          status: 'catching_up',
        },
      },
    }));

    try {
      const result = parseResult(await runCoordinatorClient(fixture, ['register', 'needle']));
      expect(result).toEqual({
        status: 'catching_up',
        equipment: {
          slot: 'kb.vector',
          name: 'needle',
          status: 'catching_up',
        },
      });
      expect(coordinator.calls).toEqual([
        {
          method: 'coordinator.registerEquipment',
          params: { name: 'needle' },
        },
      ]);
    } finally {
      await coordinator.close();
    }
  });

  it('surfaces serialized coordinator setup errors through coordinator-client.mjs', async () => {
    const fixture = createFixture();
    const coordinator = await startFakeCoordinator(fixture, () => ({
      error: {
        code: -32603,
        message: 'Another /equip is in progress for needle.',
        data: {
          code: 'equipment_install_lock_contended',
          userMessage: 'Another /equip is in progress for needle.',
          remediation: 'Wait for the in-flight install to complete or remove the stale lock file.',
          context: { name: 'needle' },
        },
      },
    }));

    try {
      const result = parseErrorResult(await runCoordinatorClient(fixture, ['register', 'needle']));
      expect(result).toMatchObject({
        status: 'error',
        code: 'equipment_install_lock_contended',
        userMessage: 'Another /equip is in progress for needle.',
        remediation: 'Wait for the in-flight install to complete or remove the stale lock file.',
        context: { name: 'needle' },
      });
    } finally {
      await coordinator.close();
    }
  });

  it('merges coordinator equipment state into --list output', async () => {
    const fixture = createFixture();
    const coordinator = await startFakeCoordinator(fixture, () => ({
      result: {
        equipment: [
          {
            slot: 'kb.vector',
            name: 'needle',
            status: 'catching_up',
          },
        ],
      },
    }));

    try {
      const result = parseResult(await runInstall(fixture, ['--list']));
      expect(result.status).toBe('catalog');
      expect(findCatalogPackage(result, 'needle')).toMatchObject({
        id: 'needle',
        status: 'catching_up',
        statusDescription: 'Registered and replaying the corpus.',
      });
      expect(findCatalogPackage(result, 'cgc')).toMatchObject({
        id: 'cgc',
        name: 'CodeGraphContext',
      });
      expect(coordinator.calls).toEqual([
        {
          method: 'coordinator.listEquipment',
          params: {},
        },
      ]);
    } finally {
      await coordinator.close();
    }
  });

  it('preserves inactive in --list when the coordinator reports a restart-cleared registration', async () => {
    const fixture = createFixture();
    const coordinator = await startFakeCoordinator(fixture, () => ({
      result: {
        equipment: [
          {
            slot: 'kb.vector',
            name: 'needle',
            status: 'inactive',
          },
        ],
      },
    }));

    try {
      const result = parseResult(await runInstall(fixture, ['--list']));
      expect(findCatalogPackage(result, 'needle')).toMatchObject({
        id: 'needle',
        status: 'inactive',
        statusDescription: 'Installed locally but not registered. Run /equip needle to reactivate.',
      });
    } finally {
      await coordinator.close();
    }
  });

  it('preserves not_equipped in --list when the coordinator reports the slot as absent', async () => {
    const fixture = createFixture();
    const coordinator = await startFakeCoordinator(fixture, () => ({
      result: {
        equipment: [
          {
            slot: 'kb.vector',
            name: 'needle',
            status: 'not_equipped',
          },
        ],
      },
    }));

    try {
      const result = parseResult(await runInstall(fixture, ['--list']));
      expect(findCatalogPackage(result, 'needle')).toMatchObject({
        id: 'needle',
        status: 'not_equipped',
        statusDescription: 'Needle is not installed.',
      });
    } finally {
      await coordinator.close();
    }
  });

  it('returns a retry suggestion when --list cannot use the coordinator helper', async () => {
    const fixture = createFixture();
    const coordinator = await startFakeCoordinator(fixture, () => ({
      error: {
        code: -32000,
        message: 'coordinator.listEquipment failed',
      },
    }));

    try {
      const result = parseErrorResult(await runInstall(fixture, ['--list']));
      expect(result).toEqual({
        status: 'error',
        message: 'Could not list equipment catalog',
        suggestions: ["Check that the Coral coordinator is running, then retry '/equip --list'."],
      });
    } finally {
      await coordinator.close();
    }
  });

  it('routes uninstall through coordinator IPC and returns uninstalled', async () => {
    const fixture = createFixture();
    const coordinator = await startFakeCoordinator(fixture, () => ({
      result: {
        status: 'uninstalled',
      },
    }));

    try {
      const result = parseResult(await runInstall(fixture, ['uninstall', 'needle']));
      expect(result).toEqual({
        status: 'uninstalled',
        name: 'needle',
      });
      expect(coordinator.calls).toEqual([
        {
          method: 'coordinator.unregisterEquipment',
          params: { name: 'needle' },
        },
      ]);
    } finally {
      await coordinator.close();
    }
  });

  it('treats uninstall as idempotent when the slot is already clear', async () => {
    const fixture = createFixture();
    const coordinator = await startFakeCoordinator(fixture, () => ({
      result: {
        status: 'not_equipped',
      },
    }));

    try {
      const result = parseResult(await runInstall(fixture, ['uninstall', 'needle']));
      expect(result).toEqual({
        status: 'not_equipped',
        name: 'needle',
      });
    } finally {
      await coordinator.close();
    }
  });

  it('returns a retry suggestion when uninstall cannot use the coordinator helper', async () => {
    const fixture = createFixture();
    const coordinator = await startFakeCoordinator(fixture, () => ({
      error: {
        code: -32000,
        message: 'coordinator.unregisterEquipment failed',
      },
    }));

    try {
      const result = parseErrorResult(await runInstall(fixture, ['uninstall', 'needle']));
      expect(result).toEqual({
        status: 'error',
        message: 'Could not uninstall needle',
        suggestions: ["Check that the Coral coordinator is running, then retry '/equip uninstall needle'."],
      });
    } finally {
      await coordinator.close();
    }
  });
});
