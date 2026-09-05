import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { sha256Hex } from '#src/infra/hash.js';
import { canonicalContractJson, normalizePersistedContractReferences } from '#src/infra/persisted-contract.js';
import type { StoreFormatManifest } from '#src/store/format-fingerprint.js';
import { currentCoralStoreFormat } from '#src/store-format.js';

const MAIN_FINGERPRINT_ASSIGNMENT = /const CURRENT_CORAL_STORE_FORMAT_FINGERPRINT\s*=\s*'(sha256:[a-f0-9]{64})';/gu;
const FIXTURE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'store-format');
const PRIOR_MANIFEST_FIXTURE = 'approved-prior.manifest.json';

const APPROVED_FORMAT_TRANSITION = {
  prior: 'sha256:ca97b533a127b1475b45a487793ab7183ae70620894d1ca36e193431065b2521',
} as const;

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

function readPriorManifest(): StoreFormatManifest {
  return JSON.parse(readFileSync(resolve(FIXTURE_DIR, PRIOR_MANIFEST_FIXTURE), 'utf8')) as StoreFormatManifest;
}

function manifestFingerprint(manifest: StoreFormatManifest): string {
  return `sha256:${sha256Hex(canonicalContractJson(manifest))}`;
}

function normalizedManifest(manifest: StoreFormatManifest): StoreFormatManifest {
  return {
    ...manifest,
    codecs: manifest.codecs.map((codec) => ({
      ...codec,
      contract: normalizePersistedContractReferences(codec.contract),
    })),
  };
}

function assertApprovedTransition(prior: StoreFormatManifest, current: StoreFormatManifest): void {
  expect(current).toStrictEqual(prior);
}

describe('store-format-fingerprint-main', () => {
  it('authorizes only the single recorded prior-to-current format transition', () => {
    expect(readdirSync(FIXTURE_DIR).sort()).toStrictEqual([PRIOR_MANIFEST_FIXTURE]);

    const priorFixture = readPriorManifest();
    expect(manifestFingerprint(priorFixture)).toBe(APPROVED_FORMAT_TRANSITION.prior);
    const prior = normalizedManifest(priorFixture);

    const mainFingerprint = readMainStoreFormatFingerprint();
    const current = currentCoralStoreFormat();
    if (current.fingerprint !== mainFingerprint) {
      expect(mainFingerprint).toBe(APPROVED_FORMAT_TRANSITION.prior);
    }
    assertApprovedTransition(prior, current.manifest);
  });

  it('rejects DDL and codec changes outside the approved transition', () => {
    const prior = normalizedManifest(readPriorManifest());
    const current = currentCoralStoreFormat().manifest;
    const extraDdl = { ...current, ddl: `${current.ddl}-- unauthorized\n` };
    expect(() => assertApprovedTransition(prior, extraDdl)).toThrow();

    const codecs = current.codecs.map((codec, index) =>
      index === 0 ? { ...codec, contract: { unauthorized: true } } : codec,
    );
    expect(() => assertApprovedTransition(prior, { ...current, codecs })).toThrow();
  });
});
