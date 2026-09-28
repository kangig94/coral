import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildSync } from 'esbuild';

import type { BuildFlavor } from '#src/infra/build-flavor.js';
import {
  CURRENT_STRICT_BUNDLE_MANIFEST_FILE,
  SUCCESSION_CAPABILITIES_FILE,
  SUCCESSION_CAPABILITY_VERSION,
} from '#src/infra/bundle-manifest-address.js';
import { isNoEntryError } from '#src/infra/fs-errors.js';
import type { CoordinatorDiscoveryRecord } from '#src/infra/backend-discovery.js';
import { coordinatorPaths } from '#src/infra/path/coordinator.js';
import { storePaths } from '#src/infra/path/store.js';
import { waitForCondition } from '#tests/support/wait-for-condition.js';

const sourceBackendBundle = join(process.cwd(), 'clients', 'build', 'coral-backend.cjs');
const sourceSentinelBundle = join(process.cwd(), 'clients', 'build', 'coral-sentinel.cjs');
const sourceCliBundle = join(process.cwd(), 'clients', 'build', 'coral-cli');
const sourceClaudeAppserverBundle = join(process.cwd(), 'clients', 'build', 'coral-claude-appserver.cjs');
const sourceDurableWrapperBundle = join(process.cwd(), 'clients', 'build', 'coral-durable-wrapper.cjs');
const sourceManifestPath = join(process.cwd(), 'clients', 'build', CURRENT_STRICT_BUNDLE_MANIFEST_FILE);
const sourceSuccessionCapabilitiesPath = join(process.cwd(), 'clients', 'build', SUCCESSION_CAPABILITIES_FILE);
const requiredBuildArtifacts = [
  sourceBackendBundle,
  sourceSentinelBundle,
  sourceCliBundle,
  sourceClaudeAppserverBundle,
  sourceDurableWrapperBundle,
  sourceManifestPath,
  sourceSuccessionCapabilitiesPath,
] as const;

type SourceManifest = {
  version: string;
  buildSetId: string;
  bundleHash: string;
  cliBundleHash: string;
  claudeAppserverBundleHash: string;
  durableWrapperBundleHash: string;
  flavor: BuildFlavor;
  storeFormatFingerprint: string;
};

function readSourceManifest(buildDir: string | null): SourceManifest {
  if (buildDir === null) assertBuildArtifactsAvailable();
  return JSON.parse(
    readFileSync(buildDir === null ? sourceManifestPath : join(buildDir, CURRENT_STRICT_BUNDLE_MANIFEST_FILE), 'utf-8'),
  ) as SourceManifest;
}

const interpositionBundles = new Map<'succession-interposition' | 'sentinel-freeze' | 'admission-freeze', string>();

/**
 * Builds the succession interposition entry point with the bridge build's embedded identity, so a fixture that
 * ships it differs from the bridge backend only in the fault plan it reads from its environment.
 */
function buildInterpositionBundle(
  manifest: SourceManifest,
  kind: 'succession-interposition' | 'sentinel-freeze' | 'admission-freeze',
): string {
  const cached = interpositionBundles.get(kind);
  if (cached !== undefined && existsSync(cached)) {
    return cached;
  }
  const outfile = join(mkdtempSync(join(tmpdir(), `coral-${kind}-`)), 'coral-backend.cjs');
  const embeddedIdentity = {
    version: manifest.version,
    buildSetId: manifest.buildSetId,
    flavor: manifest.flavor,
    storeFormatFingerprint: manifest.storeFormatFingerprint,
  };
  buildSync({
    entryPoints: [fileURLToPath(new URL(`./fixtures/${kind}-backend.ts`, import.meta.url))],
    outfile,
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    external: ['node:*', '@lydell/node-pty'],
    loader: { '.sql': 'text' },
    minify: true,
    banner: {
      js:
        `var __CORAL_BUILD_IDENTITY__=${JSON.stringify(embeddedIdentity)};` +
        'var __PLUGIN_ROOT__=require("path").resolve(__dirname,"..");' +
        'var __BUNDLE_DIR__=__dirname;' +
        'var __importMetaUrl=require("url").pathToFileURL(__filename).href;',
    },
    define: {
      __VERSION__: JSON.stringify(manifest.version),
      __BUILD_SET_ID__: JSON.stringify(manifest.buildSetId),
      __BUILD_FLAVOR__: JSON.stringify(manifest.flavor),
      __STORE_FORMAT_FINGERPRINT__: JSON.stringify(manifest.storeFormatFingerprint),
      __IS_CORAL_BACKEND_MAIN__: 'false',
      'import.meta.url': '__importMetaUrl',
    },
  });
  interpositionBundles.set(kind, outfile);
  return outfile;
}

export type PluginFixture = {
  root: string;
  flavor: BuildFlavor;
  bundleHash: string;
};

export const SHIPPED_RELEASE_TAGS = [
  'v0.10.0',
  'v0.10.1',
  'v0.10.2',
  'v0.10.3',
  'v0.10.4',
  'v0.10.5',
  'v0.10.6',
  'v0.10.7',
  'v0.10.8',
  'v0.10.9',
  'v0.10.10',
  'v0.10.11',
  'v0.10.12',
  'v0.10.13',
] as const;

export type ShippedReleaseTag = (typeof SHIPPED_RELEASE_TAGS)[number];

export type ShippedPluginFixture = PluginFixture & {
  tag: ShippedReleaseTag;
  version: string;
  cliPath: string;
  storeFormatFingerprint: string;
};

const shippedPluginFixtures = new Map<ShippedReleaseTag, ShippedPluginFixture>();

export type SpawnedCoordinator = {
  child: ReturnType<typeof spawn>;
  fixture: PluginFixture;
  home: string;
  triggerPipe: NodeJS.WritableStream | null;
  output(): string;
};

export function shippedCliEnvironment(overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) {
    if (name.startsWith('CORAL_')) delete environment[name];
  }
  return { ...environment, ...overrides };
}

export function buildArtifactsAvailable(): boolean {
  return requiredBuildArtifacts.every((path) => existsSync(path));
}

export function assertBuildArtifactsAvailable(): void {
  const missing = requiredBuildArtifacts.filter((path) => !existsSync(path));
  if (missing.length > 0) {
    throw new Error(
      `Required clients/build artifacts are missing. Run npm run build first. Missing: ${missing.join(', ')}`,
    );
  }
}

export function createPluginFixture(
  tempRoots: string[],
  options: {
    flavor: BuildFlavor;
    bundleHash?: string;
    version?: string;
    /** Ships a backend whose succession protocol follows the fault plan in its environment. */
    backend?: 'succession-interposition' | 'sentinel-freeze' | 'admission-freeze';
    /** Declares the owner acceptances the bridge build ships, instead of accepting no transferred obligation. */
    accepts?: 'bundled';
    /** Builds the fixture from another build's `clients/build` instead of this tree's. */
    sourceBuildDir?: string;
  },
): PluginFixture {
  const sourceBuildDir = options.sourceBuildDir ?? null;
  if (sourceBuildDir !== null && options.backend !== undefined) {
    throw new Error('Only this tree can build the succession interposition backend.');
  }
  const sourceBundle = (name: string): string =>
    sourceBuildDir === null ? join(process.cwd(), 'clients', 'build', name) : join(sourceBuildDir, name);
  const sourceManifest = readSourceManifest(sourceBuildDir);
  const variant = options.version !== undefined || options.bundleHash !== undefined;
  const variantHash = createHash('sha256')
    .update(
      JSON.stringify([
        sourceManifest.buildSetId,
        options.version ?? sourceManifest.version,
        options.bundleHash ?? null,
      ]),
    )
    .digest('hex');
  const buildSetId = variant
    ? `${variantHash.slice(0, 8)}-${variantHash.slice(8, 12)}-4${variantHash.slice(13, 16)}-8${variantHash.slice(17, 20)}-${variantHash.slice(20, 32)}`
    : sourceManifest.buildSetId;
  const root = mkdtempSync(join(tmpdir(), `coral-coordinator-${options.flavor}-`));
  tempRoots.push(root);

  mkdirSync(join(root, 'bridge'), { recursive: true });
  const backendPath = join(root, 'bridge', 'coral-backend.cjs');
  const sentinelPath = join(root, 'bridge', 'coral-sentinel.cjs');
  const cliPath = join(root, 'bridge', 'coral-cli');
  const claudeAppserverPath = join(root, 'bridge', 'coral-claude-appserver.cjs');
  const durableWrapperPath = join(root, 'bridge', 'coral-durable-wrapper.cjs');
  const copyBundle = (source: string, destination: string): void => {
    if (!variant) {
      copyFileSync(source, destination);
      return;
    }
    writeFileSync(
      destination,
      readFileSync(source, 'utf-8')
        .replaceAll(sourceManifest.buildSetId, buildSetId)
        .replaceAll(sourceManifest.version, options.version ?? sourceManifest.version),
      'utf-8',
    );
  };
  copyBundle(
    options.backend !== undefined
      ? buildInterpositionBundle(sourceManifest, options.backend)
      : sourceBundle('coral-backend.cjs'),
    backendPath,
  );
  if (existsSync(sourceBundle('coral-sentinel.cjs'))) {
    copyBundle(sourceBundle('coral-sentinel.cjs'), sentinelPath);
  }
  if (options.bundleHash !== undefined) {
    appendFileSync(backendPath, `\n// fixture ${options.bundleHash}\n`);
  }
  copyBundle(sourceBundle('coral-cli'), cliPath);
  copyBundle(sourceBundle('coral-claude-appserver.cjs'), claudeAppserverPath);
  copyBundle(sourceBundle('coral-durable-wrapper.cjs'), durableWrapperPath);
  const bundleHash = createHash('sha256').update(readFileSync(backendPath)).digest('hex').slice(0, 16);
  const fixtureManifest = {
    version: options.version ?? sourceManifest.version,
    buildSetId,
    bundleHash,
    cliBundleHash: createHash('sha256').update(readFileSync(cliPath)).digest('hex').slice(0, 16),
    claudeAppserverBundleHash: createHash('sha256')
      .update(readFileSync(claudeAppserverPath))
      .digest('hex')
      .slice(0, 16),
    durableWrapperBundleHash: createHash('sha256').update(readFileSync(durableWrapperPath)).digest('hex').slice(0, 16),
    flavor: options.flavor,
    storeFormatFingerprint: sourceManifest.storeFormatFingerprint,
  };
  writeFileSync(
    join(root, 'bridge', 'manifest.json'),
    `${JSON.stringify({
      version: fixtureManifest.version,
      buildSetId: fixtureManifest.buildSetId,
      bundleHash: fixtureManifest.bundleHash,
      cliBundleHash: fixtureManifest.cliBundleHash,
      claudeAppserverBundleHash: fixtureManifest.claudeAppserverBundleHash,
      flavor: fixtureManifest.flavor,
      storeFormatFingerprint: fixtureManifest.storeFormatFingerprint,
    })}\n`,
    'utf-8',
  );
  writeFileSync(
    join(root, 'bridge', CURRENT_STRICT_BUNDLE_MANIFEST_FILE),
    `${JSON.stringify(fixtureManifest)}\n`,
    'utf-8',
  );
  writeFileSync(
    join(root, 'bridge', SUCCESSION_CAPABILITIES_FILE),
    `${JSON.stringify({
      version: SUCCESSION_CAPABILITY_VERSION,
      buildSetId: fixtureManifest.buildSetId,
      bundleHash: fixtureManifest.bundleHash,
      protocols: ['prepare', 'commit'],
      accepts:
        options.accepts === 'bundled'
          ? (JSON.parse(readFileSync(sourceBundle(SUCCESSION_CAPABILITIES_FILE), 'utf-8')) as { accepts: unknown[] })
              .accepts
          : [],
    })}\n`,
    'utf-8',
  );

  mkdirSync(join(root, 'node_modules'), { recursive: true });
  symlinkSync(
    join(process.cwd(), 'node_modules', 'better-sqlite3'),
    join(root, 'node_modules', 'better-sqlite3'),
    'dir',
  );

  return {
    root,
    flavor: options.flavor,
    bundleHash,
  };
}

/**
 * The Phases 1–5 release build, the supported predecessor the Phase 6 release is paired with (AC18). It is
 * pinned by commit until that release is tagged; the pin must then move to the tag, because a squash merge
 * leaves the commit out of main's history.
 */
export const FIRST_RELEASE_REF = 'b451360ee7657db62d5e5da2ee37403a6529c481';

/**
 * Builds the first-release source into a new directory registered in `tempRoots` and returns its
 * `clients/build`. The tree comes from the pinned commit alone, so nothing in this checkout can leak into the
 * predecessor it stands for.
 */
export function materializeFirstReleaseBuild(tempRoots: string[]): string {
  try {
    execFileSync('git', ['rev-parse', '--verify', `${FIRST_RELEASE_REF}^{commit}`], { stdio: 'pipe' });
  } catch (error: unknown) {
    throw new Error(`The first-release commit ${FIRST_RELEASE_REF} is missing. Fetch the full history.`, {
      cause: error,
    });
  }
  const root = mkdtempSync(join(tmpdir(), 'coral-first-release-'));
  tempRoots.push(root);
  const archive = execFileSync('git', ['archive', '--format=tar', FIRST_RELEASE_REF], {
    maxBuffer: 256 * 1024 * 1024,
  });
  execFileSync('tar', ['-xf', '-', '-C', root], { input: archive });
  // A copy, not a link: the build receipt refuses any bundled input that resolves outside its own tree.
  cpSync(join(process.cwd(), 'node_modules'), join(root, 'node_modules'), { recursive: true, verbatimSymlinks: true });
  for (const step of [
    ['scripts/clean-dist.mjs'],
    ['node_modules/typescript/bin/tsc'],
    ['scripts/build-server.mjs', '--flavor', 'prod'],
  ]) {
    execFileSync(process.execPath, step, { cwd: root, stdio: 'pipe', maxBuffer: 64 * 1024 * 1024 });
  }
  return join(root, 'clients', 'build');
}

/** A shipped plugin root must retain its tag's files and manifest bytes. */
export function createShippedPluginFixture(tempRoots: string[], tag: ShippedReleaseTag): ShippedPluginFixture {
  const cached = shippedPluginFixtures.get(tag);
  if (cached && existsSync(cached.root)) {
    return cached;
  }

  try {
    execFileSync('git', ['rev-parse', '--verify', `refs/tags/${tag}^{commit}`], { stdio: 'pipe' });
  } catch (error: unknown) {
    throw new Error(`Required shipped release tag ${tag} is missing. Fetch the pinned v0.10.0–v0.10.13 tags.`, {
      cause: error,
    });
  }

  const root = mkdtempSync(join(tmpdir(), `coral-shipped-${tag}-`));
  try {
    const archive = execFileSync('git', ['archive', '--format=tar', `${tag}:clients`], {
      maxBuffer: 32 * 1024 * 1024,
    });
    execFileSync('tar', ['-xf', '-', '-C', root], { input: archive });

    const manifest = JSON.parse(readFileSync(join(root, 'bridge', 'manifest.json'), 'utf-8')) as {
      bundleHash?: string;
      flavor?: BuildFlavor;
      storeFormatFingerprint?: string;
    };
    if (
      typeof manifest.bundleHash !== 'string' ||
      manifest.flavor !== 'prod' ||
      typeof manifest.storeFormatFingerprint !== 'string'
    ) {
      throw new Error(`Incomplete shipped bundle manifest in ${tag}`);
    }

    mkdirSync(join(root, 'node_modules'));
    symlinkSync(
      join(process.cwd(), 'node_modules', 'better-sqlite3'),
      join(root, 'node_modules', 'better-sqlite3'),
      'dir',
    );

    const fixture: ShippedPluginFixture = {
      root,
      tag,
      version: tag.slice(1),
      flavor: manifest.flavor,
      bundleHash: manifest.bundleHash,
      cliPath: join(root, 'bridge', 'coral-cli.cjs'),
      storeFormatFingerprint: manifest.storeFormatFingerprint,
    };
    tempRoots.push(root);
    shippedPluginFixtures.set(tag, fixture);
    return fixture;
  } catch (error: unknown) {
    rmSync(root, { recursive: true, force: true });
    throw new Error(`Could not materialize shipped plugin fixture ${tag}: ${String(error)}`, { cause: error });
  }
}

export function updatePluginFixtureBundleHash(fixture: PluginFixture, bundleHash: string): PluginFixture {
  const manifestPath = join(fixture.root, 'bridge', CURRENT_STRICT_BUNDLE_MANIFEST_FILE);
  const currentManifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as SourceManifest;
  const backendPath = join(fixture.root, 'bridge', 'coral-backend.cjs');
  appendFileSync(backendPath, `\n// fixture ${bundleHash}\n`);
  const effectiveBundleHash = createHash('sha256').update(readFileSync(backendPath)).digest('hex').slice(0, 16);
  const fixtureManifest = {
    ...currentManifest,
    bundleHash: effectiveBundleHash,
  };
  writeFileSync(manifestPath, `${JSON.stringify(fixtureManifest)}\n`);
  writeFileSync(
    join(fixture.root, 'bridge', SUCCESSION_CAPABILITIES_FILE),
    `${JSON.stringify({
      version: SUCCESSION_CAPABILITY_VERSION,
      buildSetId: fixtureManifest.buildSetId,
      bundleHash: fixtureManifest.bundleHash,
      protocols: ['prepare', 'commit'],
      accepts: [],
    })}\n`,
  );
  writeFileSync(
    join(fixture.root, 'bridge', 'manifest.json'),
    `${JSON.stringify({
      version: fixtureManifest.version,
      buildSetId: fixtureManifest.buildSetId,
      bundleHash: fixtureManifest.bundleHash,
      cliBundleHash: fixtureManifest.cliBundleHash,
      claudeAppserverBundleHash: fixtureManifest.claudeAppserverBundleHash,
      flavor: fixtureManifest.flavor,
      storeFormatFingerprint: fixtureManifest.storeFormatFingerprint,
    })}\n`,
  );
  return { ...fixture, bundleHash: effectiveBundleHash };
}

export function coordinatorFilesForHome(home: string, flavor: BuildFlavor) {
  return coordinatorPaths(flavor, { baseDir: join(home, '.coral') });
}

export function storeDbPathForHome(home: string, flavor: BuildFlavor, epoch = '1'): string {
  const dbDir = storePaths(flavor, { baseDir: join(home, '.coral') }).dbDir;
  return join(dbDir, `epoch-${epoch}`, 'store.db');
}

export function readDiscoveryRecordForHome(home: string, flavor: BuildFlavor): CoordinatorDiscoveryRecord | null {
  const paths = coordinatorFilesForHome(home, flavor);
  for (const infoPath of [paths.infoFile, paths.legacyInfoFile]) {
    try {
      return JSON.parse(readFileSync(infoPath, 'utf-8')) as CoordinatorDiscoveryRecord;
    } catch (error: unknown) {
      if (isNoEntryError(error)) continue;
      if (error instanceof SyntaxError) return null;
      throw error;
    }
  }
  return null;
}

export async function waitForDiscoveryRecord(
  home: string,
  flavor: BuildFlavor,
  timeoutMs = 10_000,
): Promise<CoordinatorDiscoveryRecord> {
  await waitForCondition(() => readDiscoveryRecordForHome(home, flavor) !== null, timeoutMs);
  const record = readDiscoveryRecordForHome(home, flavor);
  if (!record) {
    throw new Error(`Expected discovery record for ${flavor}`);
  }
  return record;
}

export function spawnCoordinator(options: {
  fixture: PluginFixture;
  home: string;
  tempRoots: string[];
  env?: Record<string, string>;
  backendPath?: string;
  triggerPipe?: boolean;
  supervised?: boolean;
}): SpawnedCoordinator {
  const scratchCwd = mkdtempSync(join(tmpdir(), 'coral-coordinator-cwd-'));
  options.tempRoots.push(scratchCwd);

  const backend = options.backendPath ?? join(options.fixture.root, 'bridge', 'coral-backend.cjs');
  const child = spawn(
    'node',
    options.supervised ? [join(options.fixture.root, 'bridge', 'coral-sentinel.cjs'), backend] : [backend],
    {
      cwd: scratchCwd,
      env: {
        ...process.env,
        HOME: options.home,
        TMPDIR: options.home,
        ...(options.supervised
          ? { CORAL_SENTINEL_RUN_DIR: coordinatorFilesForHome(options.home, options.fixture.flavor).runDir }
          : {}),
        ...options.env,
      },
      stdio: options.supervised
        ? ['ignore', 'pipe', 'pipe', 'ipc']
        : options.triggerPipe
          ? ['ignore', 'pipe', 'pipe', 'pipe']
          : ['ignore', 'pipe', 'pipe'],
    },
  );

  let stdout = '';
  let stderr = '';
  const childStdout = child.stdout;
  const childStderr = child.stderr;
  if (childStdout === null || childStderr === null) {
    throw new Error('Coordinator stdout and stderr pipes were not created.');
  }
  childStdout.setEncoding('utf-8');
  childStderr.setEncoding('utf-8');
  childStdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  childStderr.on('data', (chunk: string) => {
    stderr += chunk;
  });

  return {
    child,
    fixture: options.fixture,
    home: options.home,
    triggerPipe: options.triggerPipe ? (child.stdio[3] as NodeJS.WritableStream) : null,
    output: () => `${stdout}${stderr}`,
  };
}

/**
 * ECONNREFUSED and ENOENT are different exits, and a probe must not collapse them: Node unlinks a unix
 * socket's path when `server.close()` completes (measured on Node v26.8.2, darwin; see closeIpcServer in
 * src/transport/ipc/server.ts), while a process that died with its listener still open leaves a path that
 * refuses connections and that only the next binder clears.
 */
export type CoordinatorSocketProbe = 'accepting' | 'released' | 'unlinked';

export async function probeCoordinatorSocket(socketPath: string): Promise<CoordinatorSocketProbe> {
  return await new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    socket.once('connect', () => {
      socket.destroy();
      resolve('accepting');
    });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      socket.destroy();
      if (error.code === 'ECONNREFUSED') {
        resolve('released');
        return;
      }
      if (error.code === 'ENOENT') {
        resolve('unlinked');
        return;
      }
      reject(error);
    });
  });
}

export async function waitForCoordinatorSocketRelease(
  socketPath: string,
  timeoutMs = 10_000,
): Promise<Exclude<CoordinatorSocketProbe, 'accepting'>> {
  const deadline = Date.now() + timeoutMs;
  let observed = await probeCoordinatorSocket(socketPath);
  while (observed === 'accepting' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    observed = await probeCoordinatorSocket(socketPath);
  }
  if (observed === 'accepting') {
    throw new Error(`Timed out waiting for coordinator socket release: ${socketPath}`);
  }
  return observed;
}

/** Signals a helper child and resolves only once it has exited, so cleanup never races a still-running child. */
export async function terminateChildProcess(
  child: ChildProcess,
  signal: NodeJS.Signals,
  timeoutMs = 10_000,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out waiting for helper pid ${child.pid} to exit.`)),
      timeoutMs,
    );
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
  child.kill(signal);
  await exited;
}

export async function waitForProcessExit(
  handle: SpawnedCoordinator,
  timeoutMs = 10_000,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (handle.child.exitCode !== null || handle.child.signalCode !== null) {
    return {
      code: handle.child.exitCode,
      signal: handle.child.signalCode,
    };
  }

  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for coordinator exit.\n${handle.output()}`));
    }, timeoutMs);

    handle.child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
    handle.child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

export async function stopCoordinator(handle: SpawnedCoordinator, timeoutMs = 10_000): Promise<void> {
  if (handle.child.exitCode !== null || handle.child.signalCode !== null) {
    return;
  }

  handle.child.kill('SIGTERM');
  try {
    await waitForProcessExit(handle, timeoutMs);
  } catch {
    if (handle.child.exitCode === null && handle.child.signalCode === null) {
      handle.child.kill('SIGKILL');
      await waitForProcessExit(handle, 2_000).catch(() => {});
    }
  }
}
