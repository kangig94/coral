#!/usr/bin/env node

import { maintainProjectIgnore } from './lib/project-ignore.mjs';
import { isProjectIgnoreResult } from './lib/project-ignore-result.mjs';

function parseArgs(argv) {
  let projectDir;
  let createSymlink = false;
  let maintenanceLocked = false;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--project-dir') {
      projectDir = argv[index + 1];
      index += 1;
    } else if (argv[index] === '--create-symlink') {
      createSymlink = true;
    } else if (argv[index] === '--maintenance-locked') {
      maintenanceLocked = true;
    } else {
      return null;
    }
  }
  return projectDir && maintenanceLocked ? { projectDir, createSymlink } : null;
}

const request = parseArgs(process.argv.slice(2));
if (!request) process.exit(1);

try {
  const result = maintainProjectIgnore(request);
  if (!isProjectIgnoreResult(result)) throw new Error('invalid project-ignore result');
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.status === 'complete' ? 0 : 1;
} catch {
  process.stderr.write('Coral project-ignore maintenance failed before it could report a valid result.\n');
  process.exitCode = 1;
}
