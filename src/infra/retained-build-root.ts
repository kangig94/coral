import { randomUUID } from 'node:crypto';
import {
  closeSync,
  cpSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import {
  readBoundedAdjacentManifest,
  resolveRunningBundleDir,
  strictBundleManifestSchema,
  type StrictBundleManifest,
} from './bundle-manifest.js';
import { createForeignTargetValidator } from './handoff-target.js';
import type { Runtime } from '../runtime/ports.js';

function syncTree(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error('A retained build root cannot contain symlinks.');
  if (stat.isDirectory()) {
    for (const name of readdirSync(path)) syncTree(join(path, name));
  } else if (!stat.isFile()) {
    throw new Error('A retained build root contains a non-file entry.');
  }
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function retainedBuildRoot(runtime: Runtime, buildSetId: string): string {
  if (!/^[0-9a-f-]{36}$/u.test(buildSetId)) throw new Error('Retained build identity is invalid.');
  return join(dirname(runtime.paths.coral.coordinator.runDir), 'builds', buildSetId);
}

export function validatedRetainedBuildRoot(runtime: Runtime, buildSetId: string): string | null {
  const root = retainedBuildRoot(runtime, buildSetId);
  const bundleDir = join(root, 'bridge');
  const adjacent = readBoundedAdjacentManifest(bundleDir);
  if (!adjacent.ok) return null;
  const manifest = strictBundleManifestSchema.safeParse(adjacent.value);
  if (!manifest.success || manifest.data.buildSetId !== buildSetId) return null;
  return createForeignTargetValidator()(bundleDir, manifest.data).kind === 'validated' ? root : null;
}

/** Resolve a running build by its manifest, even after its installed directory has been replaced. */
export function validatedRunningBuildRoot(
  runDir: string,
  installedRoot: string,
  manifest: StrictBundleManifest,
): string | null {
  const validate = createForeignTargetValidator();
  for (const root of [installedRoot, join(dirname(runDir), 'builds', manifest.buildSetId)]) {
    if (validate(join(root, 'bridge'), manifest).kind === 'validated') return root;
  }
  return null;
}

/** A retained copy that no longer validates must be replaced; no other process will repair it. */
export function pinRunningBuildRoot(runtime: Runtime, pluginRoot: string, manifest: StrictBundleManifest): string {
  const runningBundleDir = resolveRunningBundleDir(pluginRoot);
  if (runningBundleDir === null) throw new Error('Running bundle directory is unobservable.');
  const runningBundle = relative(realpathSync(pluginRoot), runningBundleDir);
  if (runningBundle.length === 0 || runningBundle.startsWith('..') || isAbsolute(runningBundle)) {
    throw new Error('Running bundle directory is outside its plugin root.');
  }
  const target = retainedBuildRoot(runtime, manifest.buildSetId);
  const validate = createForeignTargetValidator();
  if (existsSync(target)) {
    if (validate(join(target, 'bridge'), manifest).kind === 'validated') return target;
    if (realpathSync(target) === realpathSync(pluginRoot)) {
      throw new Error('The running build root is its own retained copy and no longer validates.');
    }
    const superseded = join(dirname(target), `.superseded-${randomUUID()}`);
    renameSync(target, superseded);
    rmSync(superseded, { recursive: true, force: true });
  }
  const parent = dirname(target);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const parentOfBuilds = openSync(dirname(parent), 'r');
  try {
    fsyncSync(parentOfBuilds);
  } finally {
    closeSync(parentOfBuilds);
  }
  const stage = join(parent, `.preparing-${randomUUID()}`);
  try {
    cpSync(resolve(pluginRoot), stage, {
      recursive: true,
      dereference: true,
      force: false,
      errorOnExist: true,
      filter: (source) => !lstatSync(source).isSymbolicLink() || existsSync(source),
    });
    if (runningBundle !== 'bridge') {
      rmSync(join(stage, 'bridge'), { recursive: true, force: true });
      renameSync(join(stage, runningBundle), join(stage, 'bridge'));
    }
    syncTree(stage);
    if (validate(join(stage, 'bridge'), manifest).kind !== 'validated') {
      throw new Error('Retained build copy does not validate.');
    }
    renameSync(stage, target);
    const fd = openSync(parent, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return target;
  } finally {
    if (existsSync(stage)) rmSync(stage, { recursive: true, force: true });
  }
}
