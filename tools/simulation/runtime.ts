import { existsSync, readFileSync, readdirSync } from 'node:fs';

import { composeChildEnv } from '../../src/infra/env-sanitize.js';
import { MAX_BUFFER } from '../../src/infra/process-constants.js';
import type { BuildFlavor } from '../../src/infra/build-flavor.js';
import type { DirentLike, Runtime, RuntimeExecOptions, ProcessPort, StoragePort } from '../../src/runtime/ports.js';
import { copySchemaAssets, resolveDefaultSchemasDir } from '../../src/store/schema-loader.js';
import { InMemoryStorage, type InMemoryRoots } from './core/memory-storage.js';
import { MockProcessSpawner } from './core/mock-process.js';
import { InMemoryObserver, InMemoryPaths, SealedEnv, SequentialIds } from './core/runtime-doubles.js';
import { DEFAULT_EPOCH_MS, VirtualTime } from './core/virtual-time.js';
import { buildExecPromise } from '../../src/runtime/exec-builder.js';

const SIMULATION_ENV_BUDGET_BYTES = 2 * 1024 * 1024;
const nodeFsSchemaStorage: Pick<StoragePort, 'existsSync' | 'readFileSync' | 'readdirSync'> = {
  existsSync,
  readFileSync: (path: string, encoding: 'utf-8') => readFileSync(path, encoding),
  readdirSync: ((path: string, options?: { withFileTypes: true }) => {
    if (options?.withFileTypes === true) {
      return readdirSync(path, options) as unknown as DirentLike[];
    }
    return readdirSync(path);
  }) as StoragePort['readdirSync'],
};

function seedStoreSchemas(storage: InMemoryStorage): void {
  const schemasDir = resolveDefaultSchemasDir();
  if (storage.existsSync(schemasDir)) {
    return;
  }

  copySchemaAssets(nodeFsSchemaStorage, storage, schemasDir, schemasDir);
}

export interface SimulationRuntimeOptions {
  epochMs?: number;
  env?: Record<string, string>;
  roots?: InMemoryRoots;
  flavor?: BuildFlavor;
}

export class SimulationRuntime implements Runtime {
  readonly flavor: BuildFlavor;
  readonly time: VirtualTime;
  readonly storage: InMemoryStorage;
  readonly paths: InMemoryPaths;
  readonly ids: SequentialIds;
  readonly env: SealedEnv;
  readonly observer: InMemoryObserver;
  readonly spawner: MockProcessSpawner;
  readonly process: ProcessPort;

  constructor(options: SimulationRuntimeOptions = {}) {
    const roots: InMemoryRoots = options.roots ?? {};
    this.flavor = options.flavor ?? 'prod';
    this.time = new VirtualTime(options.epochMs ?? DEFAULT_EPOCH_MS);
    this.env = new SealedEnv(options.env);
    this.paths = new InMemoryPaths(roots, this.flavor);
    this.storage = new InMemoryStorage(this.time, roots);
    seedStoreSchemas(this.storage);
    this.ids = new SequentialIds();
    this.observer = new InMemoryObserver();
    const inheritedEnv = this.env.fullSnapshot();
    this.spawner = new MockProcessSpawner(this.time, this.storage, {
      buildDurableEnv: (envAdditions) =>
        composeChildEnv(inheritedEnv, envAdditions ?? {}, SIMULATION_ENV_BUDGET_BYTES, new Set<string>()),
    });
    const simulationProcess = {} as ProcessPort;
    simulationProcess.spawn = (spawnOptions) => {
      const child = this.spawner.spawn(spawnOptions);
      this.observer.emit({
        child,
        command: spawnOptions.command,
        args: [...spawnOptions.args],
        ...(spawnOptions.envAdditions ? { env: { ...spawnOptions.envAdditions } } : {}),
      });
      return child;
    };
    simulationProcess.kill = (pid, signal) => {
      this.spawner.kill(pid, signal);
    };
    simulationProcess.isAlive = (pid) => this.spawner.isAlive(pid);
    simulationProcess.durable = this.spawner.durable;

    simulationProcess.exec = (command, args, options = {}) => {
      const execOptions: RuntimeExecOptions = { ...options };
      execOptions.maxBuffer ??= MAX_BUFFER;
      return buildExecPromise({
        command,
        args,
        cwd: execOptions.cwd,
        env: execOptions.env,
        inheritEnv: execOptions.inheritEnv,
        timeoutMs: execOptions.timeout,
        maxBuffer: execOptions.maxBuffer,
        encoding: execOptions.encoding ?? 'utf-8',
        spawn: simulationProcess.spawn,
        kill: simulationProcess.kill,
        setTimeout: (fn, ms) => this.time.setTimeout(fn, ms),
        clearTimeout: (handle) => this.time.clearTimeout(handle),
      });
    };

    simulationProcess.execSync = (command, args, options = {}) => {
      const execOptions: RuntimeExecOptions = { ...options };
      execOptions.maxBuffer ??= MAX_BUFFER;
      execOptions.encoding ??= 'utf-8';
      return this.spawner.execSync(command, args, execOptions);
    };

    this.process = simulationProcess;
  }
}
