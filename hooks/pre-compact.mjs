#!/usr/bin/env node

import { DatabaseSync } from './lib/sqlite.mjs';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  buildFlavor,
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

function storeDbPath() {
  const dataDir = buildFlavor() === 'dev' ? 'data-dev' : 'data';
  return join(homedir(), '.coral', dataDir, 'store', 'store.db');
}

function snapshotDirForProject(projectDir) {
  return join(projectTmpDir(projectDir), 'hooks');
}

function logNoRelevantJobs(projectDir, extra = {}) {
  logHookLine('pre-compact', 'no relevant jobs to snapshot', { projectDir, ...extra });
}

await failOpen(async () => {
  const input = JSON.parse((await readStdin()) || '{}');
  const projectDir = projectDirFromInput(input, process.cwd());
  const snapshotDir = snapshotDirForProject(projectDir);
  sweepStale(snapshotDir, SNAPSHOT_PREFIX, SNAPSHOT_TTL_MS);

  const dbPath = storeDbPath();
  if (!existsSync(dbPath)) {
    logNoRelevantJobs(projectDir);
    return;
  }

  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    // Default SQLITE_BUSY timeout is 0ms: a backend mid-write would make the
    // read throw immediately and silently skip the snapshot. Give the lock a
    // moment to clear while staying well inside the PreCompact hook budget.
    db.exec('PRAGMA busy_timeout = 1000;');
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
      if (typeof row.jobId !== 'string' || typeof row.phase !== 'string') {
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
          ...(hasArtifact ? { resultPath } : {}),
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
