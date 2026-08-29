import { readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

import { generationRunDir } from '#src/infra/path/coordinator.js';
import { PROVIDER_PATH_IDENTITY_HASH_LENGTH } from '#src/infra/path/provider-proxy.js';
import { socketPathByteLimit } from '#src/infra/path/unix-socket.js';
import { testTempRoot, userRootName } from '../../vitest/temp-root.js';

const REPO_ROOT = join(__dirname, '..', '..');

/** The suites that drive a real coordinator all the way to an acquired provider set, so the temp HOME they
 *  create is the one a guardian, reaper and proxy each bind a socket beneath. */
const BINDING_SUITES = join(REPO_ROOT, 'tests', 'e2e', 'cli', 'lifecycle');

/** `mkdtempSync` appends six characters of its own to the prefix it is given. */
const MKDTEMP_SUFFIX_LENGTH = 6;

function sourceFiles(root: string): string[] {
  const files: string[] = [];
  const directories = [root];
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory === undefined) continue;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) directories.push(path);
      else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(path);
    }
  }
  return files;
}

function temporaryHomePrefixes(): ReadonlyArray<{ prefix: string; file: string }> {
  const pattern = /(?:mkdtempSync\(\s*join\(\s*tmpdir\(\)|\.create\()\s*,?\s*[`'"]([^`'"]+)[`'"]/gu;
  return sourceFiles(BINDING_SUITES).flatMap((path) => {
    const file = relative(REPO_ROOT, path).replaceAll('\\', '/');
    return [...readFileSync(path, 'utf-8').matchAll(pattern)].map((match) => ({ prefix: match[1] ?? '', file }));
  });
}

describe('temp root socket budget', () => {
  it('leaves the lifecycle suites room to bind a provider socket inside the AF_UNIX limit', () => {
    const limit = socketPathByteLimit(process.platform);
    const filename = `provider-${'0'.repeat(PROVIDER_PATH_IDENTITY_HASH_LENGTH)}.sock`;
    const currentRoot = testTempRoot();
    const secureRootParent = basename(currentRoot) === userRootName() ? dirname(currentRoot) : currentRoot;
    const longestIdentityRoot = join(secureRootParent, userRootName(4_294_967_294));

    const overBudget = temporaryHomePrefixes()
      .map(({ prefix, file }) => {
        const home = join(longestIdentityRoot, `${prefix}${'a'.repeat(MKDTEMP_SUFFIX_LENGTH)}`);
        const socket = join(generationRunDir('prod', { baseDir: join(home, '.coral') }), filename);
        return { file, prefix, bytes: Buffer.byteLength(socket, 'utf-8'), limit };
      })
      .filter((candidate) => candidate.bytes >= candidate.limit);

    // `providerEndpoint` relocates an over-limit socket to a shared fallback root outside the HOME the test
    // built and reports nothing, so the suite fails much later as a wait that never settles.
    expect(overBudget).toEqual([]);
  });

  it('finds the prefixes it is budgeting for', () => {
    expect(temporaryHomePrefixes().length).toBeGreaterThan(0);
  });
});
