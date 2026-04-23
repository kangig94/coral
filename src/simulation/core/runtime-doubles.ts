import { basename, join } from 'node:path';
import type {
  Disposable,
  EnvPort,
  IdPort,
  RuntimeObserver,
  RuntimePaths,
  SpawnEvent,
  SpawnListener,
} from '../../runtime/ports.js';
import { coordinatorPaths } from '../../infra/coordinator-paths.js';
import type { CoralPaths } from '../../infra/coral-paths.js';
import { equipmentPaths } from '../../infra/equipment-paths.js';
import { sourceToSlug } from '../../infra/paths.js';
import { exportsPaths } from '../../infra/exports-paths.js';
import { corpusPaths } from '../../infra/corpus-paths.js';
import type { BuildFlavor } from '../../runtime/flavor.js';
import { storePaths } from '../../store/paths.js';
import { cloneSpawnEvent } from '../../runtime/spawn.js';
import { hashToken } from '../../infra/hash.js';
import { normalizePathForStorage, type InMemoryRoots } from './memory-storage.js';
import { DEFAULT_CORAL_ROOT, DEFAULT_INSTALLATIONS_DIR, DEFAULT_JOBS_DIR, DEFAULT_SESSION_BASE } from './constants.js';

const DEFAULT_RUNTIME_ROOT = `/tmp/sim/${process.pid}`;
const DEFAULT_HOME = join(DEFAULT_RUNTIME_ROOT, 'home');
const DEFAULT_PATH = '/usr/bin';
const DEFAULT_CWD = '/tmp/sim';
const DEFAULT_PID = 12_345;
const DEFAULT_PLATFORM = 'linux';

export type InMemoryPathsSnapshot = {
  namespaceCache: Array<[string, string]>;
  projectSourceCache: Array<[string, string]>;
};

function buildInMemoryCoralPaths(roots: InMemoryRoots, flavor: BuildFlavor = 'prod'): CoralPaths {
  const coralRoot = roots.coralRoot ?? DEFAULT_CORAL_ROOT;
  const opts = { baseDir: coralRoot };
  const store = storePaths(flavor, opts);
  const corpus = corpusPaths(flavor, opts);
  const coordinator = coordinatorPaths(flavor, undefined, opts);
  const exports = exportsPaths(flavor, opts);
  const equipment = equipmentPaths(flavor, opts);

  return Object.freeze({
    store,
    corpus,
    coordinator,
    exports,
    equipment,
  });
}

export class InMemoryObserver implements RuntimeObserver {
  readonly events: SpawnEvent[] = [];
  private readonly listeners = new Set<SpawnListener>();

  emit(event: SpawnEvent): void {
    const snapshot = cloneSpawnEvent(event);
    this.events.push(snapshot);
    for (const listener of this.listeners) {
      listener(cloneSpawnEvent(snapshot));
    }
  }

  onSpawn(listener: SpawnListener): Disposable {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  }
}

export class InMemoryPaths implements RuntimePaths {
  private readonly namespaceCache = new Map<string, string>();
  private readonly projectSourceCache = new Map<string, string>();
  readonly coral: CoralPaths;

  constructor(private readonly roots: InMemoryRoots = {}, flavor: BuildFlavor = 'prod') {
    this.coral = buildInMemoryCoralPaths(roots, flavor);
  }

  snapshot(): InMemoryPathsSnapshot {
    return {
      namespaceCache: [...this.namespaceCache.entries()],
      projectSourceCache: [...this.projectSourceCache.entries()],
    };
  }

  restore(snapshot: InMemoryPathsSnapshot): void {
    this.namespaceCache.clear();
    this.projectSourceCache.clear();
    for (const [key, value] of snapshot.namespaceCache) {
      this.namespaceCache.set(key, value);
    }
    for (const [key, value] of snapshot.projectSourceCache) {
      this.projectSourceCache.set(key, value);
    }
  }

  jobsDir(): string {
    return this.roots.jobsDir ?? DEFAULT_JOBS_DIR;
  }

  sessionBase(): string {
    return this.roots.sessionBase ?? DEFAULT_SESSION_BASE;
  }

  backendInfoPath(pluginRoot: string): string {
    return join(this.installationDirForNamespace(this.pluginRootNamespace(pluginRoot)), 'backend.json');
  }

  backendLockPath(pluginRoot: string): string {
    return join(this.installationDirForNamespace(this.pluginRootNamespace(pluginRoot)), 'backend.lock');
  }

  installationDirForNamespace(namespace: string): string {
    return join(this.installationsDir(), namespace);
  }

  pluginRootNamespace(pluginRoot: string): string {
    const normalized = normalizePathForStorage(pluginRoot);
    const cached = this.namespaceCache.get(normalized);
    if (cached) {
      return cached;
    }
    const namespace = hashToken(normalized, 12);
    this.namespaceCache.set(normalized, namespace);
    return namespace;
  }

  projectSource(projectRoot: string): string {
    const normalized = normalizePathForStorage(projectRoot);
    const cached = this.projectSourceCache.get(normalized);
    if (cached) {
      return cached;
    }
    const source = `local/${basename(normalized) || 'project'}-${hashToken(normalized, 8)}`;
    this.projectSourceCache.set(normalized, source);
    return source;
  }

  discussSourcesPath(): string {
    return join(this.coralRoot(), 'discuss-sources.json');
  }

  discussSourcesLockPath(): string {
    return `${this.discussSourcesPath()}.lock`;
  }

  discussBaseDirForSource(source: string): string {
    return join(this.projectDataDirForSource(source), 'discuss');
  }

  discussDiscoveryPathForSource(source: string): string {
    return join(this.discussBaseDirForSource(source), 'discovery.json');
  }

  discussDiscoveryLockPathForSource(source: string): string {
    return join(this.discussBaseDirForSource(source), '.lock');
  }

  discussSummaryIndexPathForSource(source: string): string {
    return join(this.discussBaseDirForSource(source), 'summary-index.json');
  }

  discussSessionDirForSource(source: string, sessionId: string): string {
    return join(this.discussBaseDirForSource(source), sessionId);
  }

  discussStatePath(sessionDir: string): string {
    return join(sessionDir, 'state.json');
  }

  discussEventLogPath(sessionDir: string): string {
    return join(sessionDir, 'event-log.jsonl');
  }

  private installationsDir(): string {
    return this.roots.installationsDir ?? DEFAULT_INSTALLATIONS_DIR;
  }

  private coralRoot(): string {
    return this.roots.coralRoot ?? DEFAULT_CORAL_ROOT;
  }

  private projectDataDirForSource(source: string): string {
    return join(this.coralRoot(), 'projects', sourceToSlug(source));
  }
}

export class SequentialIds implements IdPort {
  private uuidCounter = 0;
  private byteCounter = 0;

  uuid(): string {
    this.uuidCounter += 1;
    return `00000000-0000-0000-0000-${String(this.uuidCounter).padStart(12, '0')}`;
  }

  randomBytes(size: number): Buffer {
    const bytes = Buffer.alloc(size);
    for (let index = 0; index < size; index += 1) {
      bytes[index] = this.byteCounter % 256;
      this.byteCounter += 1;
    }
    return bytes;
  }

  sha256(input: string): string {
    return hashToken(input, 64);
  }
}

export class SealedEnv implements EnvPort {
  private readonly fullEnv: Readonly<Record<string, string>>;
  private readonly coralEnv: Readonly<Record<string, string>>;

  constructor(overrides: Record<string, string> = {}) {
    const fullEnv = {
      HOME: DEFAULT_HOME,
      USERPROFILE: DEFAULT_HOME,
      PATH: DEFAULT_PATH,
      PWD: DEFAULT_CWD,
      CORAL_OWNER: 'sim-owner',
      CORAL_EFFORT: 'medium',
      ...overrides,
    };
    const coralEntries = Object.fromEntries(Object.entries(fullEnv).filter(([key]) => key.startsWith('CORAL_')));
    this.fullEnv = Object.freeze({ ...fullEnv });
    this.coralEnv = Object.freeze({ ...coralEntries });
  }

  get(key: string): string | undefined {
    return this.fullEnv[key];
  }

  homedir(): string {
    return this.fullEnv.HOME ?? this.fullEnv.USERPROFILE ?? DEFAULT_HOME;
  }

  fullSnapshot(): Readonly<Record<string, string>> {
    return this.fullEnv;
  }

  coralSnapshot(): Readonly<Record<string, string>> {
    return this.coralEnv;
  }

  pid(): number {
    return DEFAULT_PID;
  }

  platform(): string {
    return DEFAULT_PLATFORM;
  }

  cwd(): string {
    return DEFAULT_CWD;
  }
}
