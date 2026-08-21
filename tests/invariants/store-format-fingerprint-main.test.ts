import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { sha256Hex } from '#src/infra/hash.js';
import { canonicalContractJson, zodPersistedContract } from '#src/infra/persisted-contract.js';
import { canonicalWorkDirWireSchema } from '#src/runtime/canonical-work-dir.js';
import type { PersistedCodecManifestEntry, StoreFormatManifest } from '#src/store/format-fingerprint.js';
import { currentCoralStoreFormat } from '#src/store-format.js';

const MAIN_FINGERPRINT_ASSIGNMENT = /const CURRENT_CORAL_STORE_FORMAT_FINGERPRINT\s*=\s*'(sha256:[a-f0-9]{64})';/gu;
const FIXTURE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'store-format');
const PRIOR_MANIFEST_FIXTURE = 'approved-prior.manifest.json';

const APPROVED_FORMAT_TRANSITION = {
  prior: 'sha256:9fd970cdcb803f517d77b133bba86ae83ef1ff662f77da8656604f32c8e67980',
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

function replaceExactlyOnce(source: string, prior: string, current: string): string {
  const first = source.indexOf(prior);
  if (first < 0 || source.indexOf(prior, first + prior.length) >= 0) {
    throw new Error(`Expected one authorized DDL fragment, found ${first < 0 ? 0 : 'more than one'}.`);
  }
  return source.slice(0, first) + current + source.slice(first + prior.length);
}

function authorizedDdl(priorDdl: string): string {
  const withWorkDir = replaceExactlyOnce(
    priorDdl,
    '  project_root            TEXT NOT NULL,\n  backend_namespace       TEXT NOT NULL,',
    '  project_root            TEXT NOT NULL,\n  work_dir                TEXT,\n  backend_namespace       TEXT NOT NULL,',
  );
  return replaceExactlyOnce(
    withWorkDir,
    '  created_at              TEXT NOT NULL,\n  last_seq                INTEGER NOT NULL\n);',
    "  created_at              TEXT NOT NULL,\n  last_seq                INTEGER NOT NULL,\n  CONSTRAINT projection_jobs_work_dir_authority CHECK ((job_kind = 'kb') = (work_dir IS NULL))\n);",
  );
}

function normalizeContract(root: unknown): unknown {
  const ids = new Map<number, Record<string, unknown>>();
  const collect = (value: unknown): void => {
    if (typeof value !== 'object' || value === null) return;
    if (!Array.isArray(value) && typeof (value as Record<string, unknown>).$id === 'number') {
      ids.set((value as Record<string, unknown>).$id as number, value as Record<string, unknown>);
    }
    for (const child of Object.values(value)) collect(child);
  };
  collect(root);

  const visit = (value: unknown, active: Set<Record<string, unknown>>): unknown => {
    if (typeof value !== 'object' || value === null) return value;
    if (Array.isArray(value)) return value.map((entry) => visit(entry, active));
    const object = value as Record<string, unknown>;
    if (typeof object.$ref === 'number') {
      const target = ids.get(object.$ref);
      if (target === undefined) throw new Error(`Persisted contract references missing id ${object.$ref}.`);
      return active.has(target) ? { $cycle: true } : visit(target, active);
    }
    const nextActive = new Set(active).add(object);
    return Object.fromEntries(
      Object.entries(object)
        .filter(([key]) => key !== '$id')
        .map(([key, child]) => [key, visit(child, nextActive)]),
    );
  };

  return visit(root, new Set());
}

function codecByName(manifest: StoreFormatManifest, name: string): PersistedCodecManifestEntry {
  const codec = manifest.codecs.find((candidate) => candidate.name === name);
  if (codec === undefined) throw new Error(`Missing persisted codec '${name}'.`);
  return codec;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function records(value: unknown, label: string): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value.map((entry, index) => record(entry, `${label}[${index}]`));
}

function assertEventBodyDelta(prior: StoreFormatManifest, current: StoreFormatManifest): void {
  const priorBody = record(codecByName(prior, 'store.events.body').contract, 'prior event body');
  const currentBody = record(codecByName(current, 'store.events.body').contract, 'current event body');
  expect(currentBody.kind).toStrictEqual(priorBody.kind);

  const priorEvents = records(priorBody.events, 'prior events');
  const currentEvents = records(currentBody.events, 'current events');
  expect(currentEvents.map(({ contract: _contract, ...event }) => event)).toStrictEqual(
    priorEvents.map(({ contract: _contract, ...event }) => event),
  );

  for (const [index, currentEvent] of currentEvents.entries()) {
    const priorEvent = priorEvents[index];
    if (priorEvent === undefined) throw new Error(`Missing prior event at index ${index}.`);
    if (currentEvent.type !== 'job.launch.requested') {
      expect(normalizeContract(currentEvent.contract)).toStrictEqual(normalizeContract(priorEvent.contract));
      continue;
    }

    const priorLaunch = record(normalizeContract(priorEvent.contract), 'prior launch contract');
    const currentLaunch = record(normalizeContract(currentEvent.contract), 'current launch contract');
    const priorOptions = records(priorLaunch.options, 'prior launch options');
    const currentOptions = records(currentLaunch.options, 'current launch options');
    const expectedCanonicalCwd = normalizeContract(zodPersistedContract(canonicalWorkDirWireSchema));

    const authorizedCurrent = structuredClone(currentLaunch);
    const authorizedOptions = records(authorizedCurrent.options, 'authorized launch options');
    for (const optionIndex of [0, 1]) {
      const currentFields = record(currentOptions[optionIndex]?.fields, `current launch option ${optionIndex} fields`);
      const currentRequest = record(currentFields.request, `current launch option ${optionIndex} request`);
      const currentRequestFields = record(currentRequest.fields, `current launch option ${optionIndex} request fields`);
      expect(normalizeContract(currentRequestFields.cwd)).toStrictEqual(expectedCanonicalCwd);

      const priorFields = record(priorOptions[optionIndex]?.fields, `prior launch option ${optionIndex} fields`);
      const priorRequest = record(priorFields.request, `prior launch option ${optionIndex} request`);
      const priorRequestFields = record(priorRequest.fields, `prior launch option ${optionIndex} request fields`);
      const authorizedFields = record(
        authorizedOptions[optionIndex]?.fields,
        `authorized launch option ${optionIndex} fields`,
      );
      const authorizedRequest = record(authorizedFields.request, `authorized launch option ${optionIndex} request`);
      record(authorizedRequest.fields, `authorized launch option ${optionIndex} request fields`).cwd =
        priorRequestFields.cwd;
    }
    expect(authorizedCurrent).toStrictEqual(priorLaunch);
  }
}

function assertProjectionRowDelta(prior: StoreFormatManifest, current: StoreFormatManifest): void {
  const priorRow = record(
    normalizeContract(codecByName(prior, 'store.projection_jobs.row').contract),
    'prior projection row',
  );
  const currentRow = record(
    normalizeContract(codecByName(current, 'store.projection_jobs.row').contract),
    'current projection row',
  );
  const currentInput = record(currentRow.input, 'current projection row input');
  const currentFields = record(currentInput.fields, 'current projection row fields');
  expect(currentFields.work_dir).toStrictEqual(
    normalizeContract(zodPersistedContract(canonicalWorkDirWireSchema.nullable())),
  );

  const authorizedCurrent = structuredClone(currentRow);
  const authorizedInput = record(authorizedCurrent.input, 'authorized projection row input');
  delete record(authorizedInput.fields, 'authorized projection row fields').work_dir;
  expect(authorizedCurrent).toStrictEqual(priorRow);
}

function assertApprovedTransition(prior: StoreFormatManifest, current: StoreFormatManifest): void {
  expect(current.kind).toBe(prior.kind);
  expect(current.ddl).toBe(authorizedDdl(prior.ddl));
  expect(current.codecs.map(({ name, persistence }) => ({ name, persistence }))).toStrictEqual(
    prior.codecs.map(({ name, persistence }) => ({ name, persistence })),
  );

  const changedCodecs = new Set(['store.events.body', 'store.projection_jobs.row']);
  for (const currentCodec of current.codecs) {
    if (changedCodecs.has(currentCodec.name)) continue;
    expect(currentCodec).toStrictEqual(codecByName(prior, currentCodec.name));
  }
  assertEventBodyDelta(prior, current);
  assertProjectionRowDelta(prior, current);
}

describe('store-format-fingerprint-main', () => {
  it('authorizes only the single recorded prior-to-current format transition', () => {
    expect(readdirSync(FIXTURE_DIR).sort()).toStrictEqual([PRIOR_MANIFEST_FIXTURE]);

    const prior = readPriorManifest();
    expect(manifestFingerprint(prior)).toBe(APPROVED_FORMAT_TRANSITION.prior);

    const mainFingerprint = readMainStoreFormatFingerprint();
    const current = currentCoralStoreFormat();
    if (current.fingerprint !== mainFingerprint) {
      expect(mainFingerprint).toBe(APPROVED_FORMAT_TRANSITION.prior);
    }
    assertApprovedTransition(prior, current.manifest);
  });

  it('rejects DDL and codec changes outside the approved transition', () => {
    const prior = readPriorManifest();
    const current = currentCoralStoreFormat().manifest;
    const extraDdl = { ...current, ddl: `${current.ddl}-- unauthorized\n` };
    expect(() => assertApprovedTransition(prior, extraDdl)).toThrow();

    const codecs = current.codecs.map((codec, index) =>
      index === 0 ? { ...codec, contract: { unauthorized: true } } : codec,
    );
    expect(() => assertApprovedTransition(prior, { ...current, codecs })).toThrow();
  });
});
