import { dirname, join } from 'node:path';

import type { StoragePort } from '../infra/port-types.js';
import { KB_RUNTIME_AUTHORITY } from '../runtime/kb-runtime-authority.js';

const CORPUS_PROJECTION_COMMITS_DIR = 'commits';
const INDEX_ARTIFACT_DIR = 'index';
const INDEX_COMMITS_DIR = 'commits';
const QUARANTINE_DIR = 'quarantine';
const QUARANTINE_MANIFEST_FILE = 'manifest.json';

export type KbCommitQuarantineResult = {
  readonly commitId: string;
  readonly quarantineDir: string;
  readonly artifacts: readonly ('commit' | 'index')[];
};

export type QuarantineKbCommitEvidenceOptions = {
  readonly runtimeDir: string;
  readonly storage: StoragePort;
  readonly commitId: string;
  readonly stagingId: string;
  readonly quarantinedAt: string;
};

export function quarantineKbCommitEvidence({
  runtimeDir,
  storage,
  commitId,
  stagingId,
  quarantinedAt,
}: QuarantineKbCommitEvidenceOptions): KbCommitQuarantineResult {
  assertSafeCommitId(commitId);
  const corpusProjectionRoot = join(runtimeDir, KB_RUNTIME_AUTHORITY.corpusProjection);
  const commitRoot = join(corpusProjectionRoot, CORPUS_PROJECTION_COMMITS_DIR);
  const indexCommitRoot = join(corpusProjectionRoot, INDEX_ARTIFACT_DIR, INDEX_COMMITS_DIR);
  const quarantineRoot = join(corpusProjectionRoot, QUARANTINE_DIR);
  const commitSource = join(commitRoot, commitId);
  const indexSource = join(indexCommitRoot, commitId);
  const finalDirectory = join(quarantineRoot, commitId);

  if (!storage.existsSync(commitSource)) {
    throw new Error(`KB commit '${commitId}' is not present in the active commit evidence.`);
  }
  if (storage.existsSync(finalDirectory)) {
    throw new Error(`KB commit '${commitId}' already has retained quarantine evidence.`);
  }

  storage.mkdirSync(quarantineRoot, { recursive: true });
  requireDirectorySync(storage, corpusProjectionRoot, quarantineRoot);

  const stagingDirectory = join(quarantineRoot, `.staging-${stagingId}`);
  storage.mkdirSync(stagingDirectory);
  requireDirectorySync(storage, quarantineRoot);

  const artifacts: Array<'commit' | 'index'> = [];
  moveEvidence(storage, commitSource, join(stagingDirectory, 'commit'));
  artifacts.push('commit');

  if (storage.existsSync(indexSource)) {
    moveEvidence(storage, indexSource, join(stagingDirectory, 'index'));
    artifacts.push('index');
  }

  const manifest = {
    schemaVersion: 1,
    commitId,
    quarantinedAt,
    artifacts,
  } as const;
  if (
    !storage.writeAtomicDurableSync(
      join(stagingDirectory, QUARANTINE_MANIFEST_FILE),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { encoding: 'utf-8', mode: 0o600 },
    )
  ) {
    throw new Error('KB commit quarantine manifest could not be durably written.');
  }
  requireDirectorySync(storage, stagingDirectory);

  storage.renameSync(stagingDirectory, finalDirectory);
  requireDirectorySync(storage, quarantineRoot, commitRoot, ...(artifacts.includes('index') ? [indexCommitRoot] : []));

  return { commitId, quarantineDir: finalDirectory, artifacts };
}

function moveEvidence(storage: StoragePort, source: string, destination: string): void {
  storage.renameSync(source, destination);
  requireDirectorySync(storage, dirname(source), dirname(destination));
}

function requireDirectorySync(storage: StoragePort, ...directories: readonly string[]): void {
  for (const directory of new Set(directories)) {
    if (!storage.syncDirectoryDurableSync(directory)) {
      throw new Error('KB commit quarantine directory metadata could not be synchronized.');
    }
  }
}

function assertSafeCommitId(commitId: string): void {
  if (
    commitId.length === 0 ||
    commitId.length > 255 ||
    commitId === '.' ||
    commitId === '..' ||
    commitId.includes('/') ||
    commitId.includes('\\') ||
    commitId.includes('\0')
  ) {
    throw new Error('KB commit ID must be one safe filesystem path segment.');
  }
}
