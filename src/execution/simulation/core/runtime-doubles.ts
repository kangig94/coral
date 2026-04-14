import { createHash } from 'node:crypto';
import { basename, join } from 'node:path';
import type {
  Disposable,
  RuntimeEnv,
  RuntimeIds,
  RuntimeObserver,
  RuntimePaths,
  SpawnEvent,
  SpawnListener,
} from '../../runtime.js';
import { normalizePathForStorage, type InMemoryRoots } from './memory-storage.js';

const DEFAULT_HOME = '/tmp/sim/home';
const DEFAULT_PATH = '/usr/bin';
const DEFAULT_CWD = '/tmp/sim';
const DEFAULT_PID = 12_345;
const DEFAULT_PLATFORM = 'linux';
const DEFAULT_JOBS_DIR = '/tmp/sim/jobs';
const DEFAULT_SESSION_BASE = '/tmp/sim/sessions';
const DEFAULT_INSTALLATIONS_DIR = '/tmp/sim/installations';

export type InMemoryPathsSnapshot = {
  namespaceCache: Array<[string, string]>;
  projectSourceCache: Array<[string, string]>;
};

function hashToken(input: string, length: number): string {
  return createHash('sha256').update(input).digest('hex').slice(0, length);
}

function cloneSpawnEvent(event: SpawnEvent): SpawnEvent {
  return {
    child: event.child,
    command: event.command,
    args: [...event.args],
    ...(event.env ? { env: { ...event.env } } : {}),
  };
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

  constructor(private readonly roots: InMemoryRoots = {}) {}

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
    return join(this.installationsDir(), this.pluginRootNamespace(pluginRoot), 'backend.json');
  }

  backendLockPath(pluginRoot: string): string {
    return join(this.installationsDir(), this.pluginRootNamespace(pluginRoot), 'backend.lock');
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

  private installationsDir(): string {
    return this.roots.installationsDir ?? DEFAULT_INSTALLATIONS_DIR;
  }
}

export class SequentialIds implements RuntimeIds {
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
}

export class SealedEnv implements RuntimeEnv {
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
