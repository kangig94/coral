#!/usr/bin/env node

import { maintainProjectIgnore } from './lib/project-ignore.mjs';

function parseArgs(argv) {
  let projectDir;
  let createSymlink = false;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--project-dir') {
      projectDir = argv[index + 1];
      index += 1;
    } else if (argv[index] === '--create-symlink') {
      createSymlink = true;
    } else {
      return null;
    }
  }
  return projectDir ? { projectDir, createSymlink } : null;
}

const request = parseArgs(process.argv.slice(2));
if (!request) process.exit(1);

try {
  const result = maintainProjectIgnore(request);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) process.exitCode = 1;
} catch {
  process.stderr.write('Coral project-ignore maintenance failed safely; legacy protection was not intentionally removed.\n');
  process.exitCode = 1;
}
