#!/usr/bin/env node

import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  buildFlavor,
  coralStateRoot,
  currentStoreFormatFingerprint,
  exitIfChildProcess,
  exitIfWrongFlavor,
  failOpen,
  logHookLine,
  readStdin,
  sweepStale,
} from './lib/hook-utils.mjs';
import { isLivePhase, SNAPSHOT_PREFIX, SNAPSHOT_TTL_MS, snapshotFileName } from './lib/jobs-state.mjs';
import { exportsJobsDir, projectDirFromInput, projectTmpDir } from './lib/plugin-paths.mjs';

exitIfChildProcess();
exitIfWrongFlavor();

// Self-contained mirror of the path authority in src/infra/path/store.ts.
function storeDbPath(flavor = buildFlavor(), stateRoot = coralStateRoot()) {
  const dataDir = flavor === 'dev' ? 'data-dev' : 'data';
  return join(stateRoot, 'gen2', dataDir, 'store', 'store.db');
}

function storeDiscardRemediation(flavor = buildFlavor()) {
  return flavor === 'dev'
    ? "To deliberately discard this store, run 'coral-cli backend store-reset discard --target gen2 --flavor dev', then retry compaction."
    : "To deliberately discard this store, run 'coral-cli backend store-reset discard --target gen2 --flavor prod', then retry compaction.";
}

function snapshotDirForProject(projectDir) {
  return join(projectTmpDir(projectDir), 'hooks');
}

function logNoRelevantJobs(projectDir, extra = {}) {
  logHookLine('pre-compact', 'no relevant jobs to snapshot', { projectDir, ...extra });
}

function logSnapshotSkipped(projectDir, reason, remediation) {
  logHookLine('pre-compact', 'compact snapshot skipped', { projectDir, reason, remediation });
}

const SAFE_JOB_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

await failOpen(async () => {
  const input = JSON.parse((await readStdin()) || '{}');
  const projectDir = resolve(projectDirFromInput(input, process.cwd()));
  const snapshotDir = snapshotDirForProject(projectDir);
  sweepStale(snapshotDir, SNAPSHOT_PREFIX, SNAPSHOT_TTL_MS);

  const dbPath = storeDbPath();
  if (!existsSync(dbPath)) {
    logNoRelevantJobs(projectDir);
    return;
  }
  const expectedFingerprint = currentStoreFormatFingerprint();
  if (expectedFingerprint === null) {
    logSnapshotSkipped(
      projectDir,
      'installed plugin manifest has no valid store format fingerprint',
      'Rebuild or reinstall the Coral plugin before relying on compact recovery.',
    );
    return;
  }
  const sidecarPath = `${dbPath}.format`;
  let publishedFingerprint;
  try {
    publishedFingerprint = readFileSync(sidecarPath, 'utf8').trim();
  } catch {
    logSnapshotSkipped(
      projectDir,
      'store format sidecar is missing or unreadable',
      'Restart Coral through a normal provider launch so the writable daemon can publish the current store marker.',
    );
    return;
  }
  if (publishedFingerprint !== expectedFingerprint) {
    logSnapshotSkipped(
      projectDir,
      'store format sidecar does not match the installed plugin',
      storeDiscardRemediation(),
    );
    return;
  }

  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    // Default SQLITE_BUSY timeout is 0ms: a backend mid-write would make the
    // read throw immediately and silently skip the snapshot. Give the lock a
    // moment to clear while staying well inside the PreCompact hook budget.
    db.exec('PRAGMA busy_timeout = 1000;');
    try {
      const storedFingerprint = db
        .prepare("SELECT value FROM meta WHERE key = 'store_format_fingerprint' LIMIT 1")
        .get()?.value;
      if (storedFingerprint !== expectedFingerprint) {
        logSnapshotSkipped(
          projectDir,
          'store format fingerprint mismatch',
          storeDiscardRemediation(),
        );
        return;
      }
    } catch (error) {
      logNoRelevantJobs(projectDir, {
        reason: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    let rows;
    try {
      rows = db
        .prepare(
          `SELECT job_id AS jobId, phase
             FROM projection_jobs
            WHERE project_root = ?
            ORDER BY last_seq DESC
            LIMIT 20`,
        )
        .all(projectDir);
    } catch (error) {
      logNoRelevantJobs(projectDir, {
        reason: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    const jobs = rows.flatMap((row) => {
      if (typeof row.jobId !== 'string' || !SAFE_JOB_ID.test(row.jobId) || typeof row.phase !== 'string') {
        logSnapshotSkipped(
          projectDir,
          'projection_jobs contains an unsafe job identifier',
          "Run 'coral-cli backend shutdown' and report this projection integrity failure. Do not edit the database or discard the store solely because of this row.",
        );
        return [];
      }

      const resultPath = join(exportsJobsDir(buildFlavor()), row.jobId, 'result.md');
      const hasArtifact = existsSync(resultPath);
      if (!isLivePhase(row.phase) && !hasArtifact) {
        return [];
      }

      return [
        {
          jobId: row.jobId,
          phase: row.phase,
          hasResult: hasArtifact,
        },
      ];
    });

    if (jobs.length === 0) {
      logNoRelevantJobs(projectDir);
      return;
    }

    mkdirSync(snapshotDir, { recursive: true });
    const capturedAtMs = Date.now();
    const snapshotPath = join(snapshotDir, snapshotFileName(capturedAtMs, String(process.pid)));
    writeFileSync(
      snapshotPath,
      `${JSON.stringify(
        {
          version: 1,
          projectDir,
          capturedAtMs,
          jobs,
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    logHookLine('pre-compact', 'captured job snapshot', {
      projectDir,
      count: jobs.length,
      snapshotPath,
    });
  } finally {
    db.close();
  }
}, 'pre-compact');
