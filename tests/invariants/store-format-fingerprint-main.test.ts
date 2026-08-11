import { execFileSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

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

function readMainSource(): string {
  const failures: string[] = [];
  for (const revision of MAIN_REVISIONS) {
    try {
      return execFileSync('git', ['show', `${revision}:tests/unit/store/format-fingerprint.test.ts`], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      failures.push(`${revision}: ${error instanceof Error ? error.message.trim() : String(error)}`);
    }
  }

  throw new Error(`Could not read main's store format fingerprint pin.\n${failures.join('\n')}`);
}

function readMainStoreFormatFingerprint(): string {
  const source = readMainSource();
  const fingerprints = [...source.matchAll(MAIN_FINGERPRINT_ASSIGNMENT)].map((match) => match[1]);

  if (fingerprints.length !== 1 || fingerprints[0] === undefined) {
    throw new Error(`Expected one store format fingerprint pin on main, found ${fingerprints.length}.`);
  }

  return fingerprints[0];
}

describe('store-format-fingerprint-main', () => {
  it('should keep the computed store format fingerprint equal to main', () => {
    expect(currentCoralStoreFormat().fingerprint).toBe(readMainStoreFormatFingerprint());
  });
});
