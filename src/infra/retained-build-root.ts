import { randomUUID } from 'node:crypto';
import { closeSync, cpSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import type { StrictBundleManifest } from './bundle-manifest.js';
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
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

export function retainedBuildRoot(runtime: Runtime, buildSetId: string): string {
  if (!/^[0-9a-f-]{36}$/u.test(buildSetId)) throw new Error('Retained build identity is invalid.');
  return join(dirname(runtime.paths.coral.coordinator.runDir), 'builds', buildSetId);
}

export function pinRunningBuildRoot(
  runtime: Runtime,
  pluginRoot: string,
  manifest: StrictBundleManifest,
): string {
  const target = retainedBuildRoot(runtime, manifest.buildSetId);
  const validate = createForeignTargetValidator();
  if (existsSync(target)) {
    if (validate(join(target, 'bridge'), manifest).kind !== 'validated') {
      throw new Error('Previously retained build root no longer validates.');
    }
    return target;
  }
  const parent = dirname(target);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const parentOfBuilds = openSync(dirname(parent), 'r');
  try { fsyncSync(parentOfBuilds); } finally { closeSync(parentOfBuilds); }
  const stage = join(parent, `.preparing-${randomUUID()}`);
  try {
    cpSync(resolve(pluginRoot), stage, {
      recursive: true, dereference: true, force: false, errorOnExist: true,
      filter: (source) => !lstatSync(source).isSymbolicLink() || existsSync(source),
    });
    syncTree(stage);
    if (validate(join(stage, 'bridge'), manifest).kind !== 'validated') {
      throw new Error('Retained build copy does not validate.');
    }
    renameSync(stage, target);
    const fd = openSync(parent, 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
    return target;
  } finally {
    if (existsSync(stage)) rmSync(stage, { recursive: true, force: true });
  }
}
