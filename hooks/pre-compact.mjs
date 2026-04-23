#!/usr/bin/env node

import Database from 'better-sqlite3';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { buildFlavor, failOpen, logHookLine, readStdin, sweepStale } from './lib/hook-utils.mjs';
import { isLivePhase, SNAPSHOT_PREFIX, SNAPSHOT_TTL_MS, snapshotFileName } from './lib/jobs-state.mjs';
import { JOBS_DIR, projectDirFromInput, projectTmpDir } from './lib/plugin-paths.mjs';

function storeDbPath() {
  const dataDir = buildFlavor() === 'dev' ? 'data-dev' : 'data';
  return join(homedir(), '.coral', dataDir, 'store', 'store.db');
}

function snapshotDirForProject(projectDir) {
  return join(projectTmpDir(projectDir), 'hooks');
}

await failOpen(async () => {
  const input = JSON.parse((await readStdin()) || '{}');
  const projectDir = projectDirFromInput(input, process.cwd());
  const snapshotDir = snapshotDirForProject(projectDir);
  sweepStale(snapshotDir, SNAPSHOT_PREFIX, SNAPSHOT_TTL_MS);

  const dbPath = storeDbPath();
  if (!existsSync(dbPath)) {
    logHookLine('pre-compact', 'store db missing; skipping snapshot', { projectDir });
    return;
  }

  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const rows = db
      .prepare(
        `SELECT job_id AS jobId, phase
           FROM projection_jobs
          WHERE project_root = ?
          ORDER BY last_seq DESC
          LIMIT 20`,
      )
      .all(projectDir);

    const jobs = rows.flatMap((row) => {
      if (typeof row.jobId !== 'string' || typeof row.phase !== 'string') {
        return [];
      }

      const resultPath = join(JOBS_DIR, row.jobId, 'result.md');
      const hasArtifact = existsSync(resultPath);
      if (!isLivePhase(row.phase) && !hasArtifact) {
        return [];
      }

      return [{
        jobId: row.jobId,
        phase: row.phase,
        ...(hasArtifact ? { resultPath } : {}),
      }];
    });

    if (jobs.length === 0) {
      logHookLine('pre-compact', 'no relevant jobs to snapshot', { projectDir });
      return;
    }

    mkdirSync(snapshotDir, { recursive: true });
    const capturedAtMs = Date.now();
    const snapshotPath = join(snapshotDir, snapshotFileName(capturedAtMs, String(process.pid)));
    writeFileSync(
      snapshotPath,
      `${JSON.stringify({
        version: 1,
        projectDir,
        capturedAtMs,
        jobs,
      }, null, 2)}\n`,
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
