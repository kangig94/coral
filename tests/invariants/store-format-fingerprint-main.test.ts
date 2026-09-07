import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { normalizePersistedContractReferences } from '#src/infra/persisted-contract.js';
import { currentCoralStoreFormat } from '#src/store-format.js';

const MAIN_FINGERPRINT_ASSIGNMENT = /const CURRENT_CORAL_STORE_FORMAT_FINGERPRINT\s*=\s*'(sha256:[a-f0-9]{64})';/gu;

/**
 * `origin/main` first, because CI has no local `main`. `actions/checkout` with `fetch-depth: 0` fetches into
 * `refs/remotes/origin/*` and only makes the checked-out ref a local branch, and git's name resolution does
 * not fall back from `main` to `refs/remotes/origin/main` — verified by reproducing that ref layout, where
 * `git rev-parse main` fails with "Needed a single revision". Trying the bare name second keeps this working
 * in a local clone that has `main` but no remote.
 */
const MAIN_REVISIONS = ['origin/main', 'main'] as const;

function readMainFile(path: string): string {
  const failures: string[] = [];
  for (const revision of MAIN_REVISIONS) {
    try {
      return execFileSync('git', ['show', `${revision}:${path}`], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      failures.push(`${revision}: ${error instanceof Error ? error.message.trim() : String(error)}`);
    }
  }

  throw new Error(`Could not read '${path}' from main.\n${failures.join('\n')}`);
}

function readMainStoreFormatFingerprint(): string {
  const source = readMainFile('tests/unit/store/format-fingerprint.test.ts');
  const fingerprints = [...source.matchAll(MAIN_FINGERPRINT_ASSIGNMENT)].map((match) => match[1]);

  if (fingerprints.length !== 1 || fingerprints[0] === undefined) {
    throw new Error(`Expected one store format fingerprint pin on main, found ${fingerprints.length}.`);
  }

  return fingerprints[0];
}

function packageVersion(source: string): string {
  const parsed = JSON.parse(source) as { version?: unknown };
  if (typeof parsed.version !== 'string') {
    throw new Error('Expected package.json to declare a string version.');
  }
  return parsed.version;
}

describe('store-format-fingerprint-main', () => {
  it('requires a product version change before the store-format fingerprint may change', () => {
    const mainFingerprint = readMainStoreFormatFingerprint();
    const current = currentCoralStoreFormat();
    const currentVersion = packageVersion(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'));
    const mainVersion = packageVersion(readMainFile('package.json'));

    if (currentVersion === mainVersion) {
      expect(current.fingerprint).toBe(mainFingerprint);
    }
  });

  it('compares shared and repeated persisted-contract nodes by meaning', () => {
    const shared = {
      $id: 0,
      left: { $id: 1, type: 'string' },
      right: { $ref: 1 },
    };
    const repeated = {
      $id: 0,
      left: { $id: 1, type: 'string' },
      right: { $id: 2, type: 'string' },
    };

    expect(normalizePersistedContractReferences(shared)).toStrictEqual(normalizePersistedContractReferences(repeated));
  });
});
