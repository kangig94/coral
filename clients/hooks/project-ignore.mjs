#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { isProjectIgnoreContext, maintainProjectIgnore } from './lib/project-ignore.mjs';
import { isProjectIgnoreResult } from './lib/project-ignore-result.mjs';
import {
  PROJECT_IGNORE_CONTEXT_PROBE_BUDGET_MS,
  PROJECT_IGNORE_LOCK_WRAPPER_BUDGET_MS,
} from './lib/hook-utils.mjs';

const LOCK_UNAVAILABLE_EXIT_CODE = 69;

function parseArgs(argv) {
  let projectDir;
  let createSymlink = false;
  let maintenanceLocked = false;
  let lockWrapperStartedNs;
  let projectContext;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--project-dir') {
      projectDir = argv[index + 1];
      index += 1;
    } else if (argv[index] === '--create-symlink') {
      createSymlink = true;
    } else if (argv[index] === '--maintenance-locked') {
      maintenanceLocked = true;
    } else if (argv[index] === '--lock-wrapper-started-ns') {
      lockWrapperStartedNs = argv[index + 1];
      index += 1;
    } else if (argv[index] === '--project-context') {
      try {
        projectContext = JSON.parse(argv[index + 1]);
      } catch {
        return null;
      }
      index += 1;
    } else {
      return null;
    }
  }
  return projectDir &&
    maintenanceLocked &&
    lockWrapperStartedNs &&
    isProjectIgnoreContext(projectContext) &&
    projectContext.projectDir === projectDir &&
    projectContext.refusalReason === null
    ? { projectDir, createSymlink, lockWrapperStartedNs, projectContext }
    : null;
}

function lockWrapperWithinBudget(startedNs) {
  try {
    const elapsedNs = process.hrtime.bigint() - BigInt(startedNs);
    const budgetMs = PROJECT_IGNORE_CONTEXT_PROBE_BUDGET_MS + PROJECT_IGNORE_LOCK_WRAPPER_BUDGET_MS;
    return elapsedNs >= 0 && elapsedNs <= BigInt(budgetMs) * 1_000_000n;
  } catch {
    return false;
  }
}

if (process.argv.slice(2).length === 1 && process.argv[2] === '--validate-result') {
  try {
    const result = JSON.parse(readFileSync(0, 'utf-8'));
    process.exitCode = isProjectIgnoreResult(result) ? 0 : 1;
  } catch {
    process.exitCode = 1;
  }
} else {
  const request = parseArgs(process.argv.slice(2));
  if (!request) process.exit(1);
  if (!lockWrapperWithinBudget(request.lockWrapperStartedNs)) process.exit(LOCK_UNAVAILABLE_EXIT_CODE);

  try {
    const result = maintainProjectIgnore({
      projectDir: request.projectDir,
      createSymlink: request.createSymlink,
      context: request.projectContext,
    });
    if (!isProjectIgnoreResult(result)) throw new Error('invalid project-ignore result');
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result.status === 'complete' ? 0 : 1;
  } catch {
    process.stderr.write('Coral project-ignore maintenance failed before it could report a valid result.\n');
    process.exitCode = 1;
  }
}
