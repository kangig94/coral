import { dirname, join } from 'node:path';

import type { StoragePort } from '../infra/port-types.js';
import { documentedCoralSetupError } from '../runtime/errors.js';
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
    throw documentedCoralSetupError({
      code: 'kb_commit_not_found',
      commitId,
      commitSource,
    });
  }
  if (storage.existsSync(finalDirectory)) {
    throw documentedCoralSetupError({
      code: 'kb_commit_already_quarantined',
      commitId,
      quarantineDir: finalDirectory,
    });
  }

  storage.mkdirSync(quarantineRoot, { recursive: true });
  requireDirectorySync(storage, commitId, corpusProjectionRoot, quarantineRoot);

  const stagingDirectory = join(quarantineRoot, `.staging-${stagingId}`);
  storage.mkdirSync(stagingDirectory);
  requireDirectorySync(storage, commitId, quarantineRoot);

  const artifacts: Array<'commit' | 'index'> = [];
  moveEvidence(storage, commitId, commitSource, join(stagingDirectory, 'commit'));
  artifacts.push('commit');

  if (storage.existsSync(indexSource)) {
    moveEvidence(storage, commitId, indexSource, join(stagingDirectory, 'index'));
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
    throw documentedCoralSetupError({
      code: 'kb_commit_quarantine_failed',
      commitId,
      reason: 'manifest-not-durable',
      stagingDirectory,
    });
  }
  requireDirectorySync(storage, commitId, stagingDirectory);

  storage.renameSync(stagingDirectory, finalDirectory);
  requireDirectorySync(
    storage,
    commitId,
    quarantineRoot,
    commitRoot,
    ...(artifacts.includes('index') ? [indexCommitRoot] : []),
  );

  return { commitId, quarantineDir: finalDirectory, artifacts };
}

function moveEvidence(storage: StoragePort, commitId: string, source: string, destination: string): void {
  storage.renameSync(source, destination);
  requireDirectorySync(storage, commitId, dirname(source), dirname(destination));
}

function requireDirectorySync(storage: StoragePort, commitId: string, ...directories: readonly string[]): void {
  for (const directory of new Set(directories)) {
    if (!storage.syncDirectoryDurableSync(directory)) {
      throw documentedCoralSetupError({
        code: 'kb_commit_quarantine_failed',
        commitId,
        reason: 'directory-sync-failed',
        directory,
      });
    }
  }
}

export function isSafeKbCommitId(commitId: string): boolean {
  return !(
    commitId.length === 0 ||
    commitId.length > 255 ||
    commitId === '.' ||
    commitId === '..' ||
    commitId.includes('/') ||
    commitId.includes('\\') ||
    commitId.includes('\0')
  );
}

export function assertSafeCommitId(commitId: string): void {
  if (!isSafeKbCommitId(commitId)) {
    throw documentedCoralSetupError({ code: 'kb_commit_id_invalid', commitId });
  }
}
