#!/usr/bin/env node

import { closeSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  openProjectIgnoreMaintenanceLock,
  PROJECT_IGNORE_CONTEXT_PROBE_BUDGET_MS,
  PROJECT_IGNORE_LOCK_CONFLICT_EXIT_CODE,
  PROJECT_IGNORE_LOCK_WRAPPER_BUDGET_MS,
} from './lib/hook-utils.mjs';
import { projectIgnoreContextRefusal, resolveProjectContext } from './lib/project-ignore.mjs';

const PROJECT_IGNORE_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'project-ignore.mjs');
const LOCK_UNAVAILABLE_EXIT_CODE = 69;

function parseArgs(argv) {
  let projectDir;
  let createSymlink = false;
  let startedNs;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--project-dir') {
      projectDir = argv[index + 1];
      index += 1;
    } else if (argv[index] === '--create-symlink') {
      createSymlink = true;
    } else if (argv[index] === '--started-ns') {
      startedNs = argv[index + 1];
      index += 1;
    } else {
      return null;
    }
  }
  return projectDir ? { projectDir, createSymlink, startedNs } : null;
}

const request = parseArgs(process.argv.slice(2));
if (!request || typeof process.execve !== 'function') process.exit(LOCK_UNAVAILABLE_EXIT_CODE);

const ownerStartedNs = request.startedNs ?? process.hrtime.bigint().toString();
let contextProbeDeadlineNs;
let ownerDeadlineNs;
try {
  const startedNs = BigInt(ownerStartedNs);
  if (startedNs < 0 || startedNs > process.hrtime.bigint()) process.exit(LOCK_UNAVAILABLE_EXIT_CODE);
  contextProbeDeadlineNs =
    startedNs + BigInt(PROJECT_IGNORE_CONTEXT_PROBE_BUDGET_MS) * 1_000_000n;
  ownerDeadlineNs =
    contextProbeDeadlineNs + BigInt(PROJECT_IGNORE_LOCK_WRAPPER_BUDGET_MS) * 1_000_000n;
} catch {
  process.exit(LOCK_UNAVAILABLE_EXIT_CODE);
}

const projectContext = resolveProjectContext(request.projectDir, contextProbeDeadlineNs);
const contextRefusal = projectIgnoreContextRefusal(projectContext);
if (contextRefusal) {
  writeFileSync(1, `${JSON.stringify(contextRefusal)}\n`);
  process.exit(1);
}
if (process.hrtime.bigint() > ownerDeadlineNs) process.exit(LOCK_UNAVAILABLE_EXIT_CODE);

try {
  // `process.execve` preserves only standard descriptors, so fd 0 carries the validated lock inode into flock.
  closeSync(0);
} catch {
  process.exit(LOCK_UNAVAILABLE_EXIT_CODE);
}
const lockFd = openProjectIgnoreMaintenanceLock();
if (lockFd !== 0) {
  if (lockFd !== null) closeSync(lockFd);
  process.exit(LOCK_UNAVAILABLE_EXIT_CODE);
}
if (process.hrtime.bigint() > ownerDeadlineNs) process.exit(LOCK_UNAVAILABLE_EXIT_CODE);

try {
  const maintainerArgs = [
    process.execPath,
    PROJECT_IGNORE_SCRIPT,
    '--maintenance-locked',
    '--lock-wrapper-started-ns',
    ownerStartedNs,
    '--project-dir',
    projectContext.projectDir,
    '--project-context',
    JSON.stringify(projectContext),
  ];
  if (request.createSymlink) maintainerArgs.push('--create-symlink');
  process.execve(
    '/bin/sh',
    [
      'sh',
      '-c',
      'exec flock "$@"',
      'sh',
      '--exclusive',
      '--nonblock',
      '--no-fork',
      '--conflict-exit-code',
      String(PROJECT_IGNORE_LOCK_CONFLICT_EXIT_CODE),
      '/dev/fd/0',
      ...maintainerArgs,
    ],
    process.env,
  );
} catch {
  process.exit(LOCK_UNAVAILABLE_EXIT_CODE);
}
