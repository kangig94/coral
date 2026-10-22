#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
import { projectDirFromInput, projectTmpDir } from './lib/plugin-paths.mjs';
import {
  isSqliteWaitBudgetExhausted,
  openLockedReadOnlyStoreDatabase,
  resolveCurrentStoreDbPath,
} from './lib/store-epoch.mjs';

exitIfChildProcess();
exitIfWrongFlavor();

// Self-contained mirror of the path authority in src/infra/path/store.ts.
function storeDbDir(flavor = buildFlavor(), stateRoot = coralStateRoot()) {
  const dataDir = flavor === 'dev' ? 'data-dev' : 'data';
  return join(stateRoot, 'gen2', dataDir, 'store');
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
const SQLITE_WAIT_DEADLINE_MS = performance.now() + 2000;
// The PreCompact hook is killed at 3 s; every blocking step must finish inside this deadline.
const HOOK_WORK_DEADLINE_MS = performance.now() + 2500;
const MIN_RESULT_LOOKUP_MS = 250;

await failOpen(async () => {
  const input = JSON.parse((await readStdin()) || '{}');
  const projectDir = resolve(projectDirFromInput(input, process.cwd()));
  const snapshotDir = snapshotDirForProject(projectDir);
  sweepStale(snapshotDir, SNAPSHOT_PREFIX, SNAPSHOT_TTL_MS);

  const dbPath = resolveCurrentStoreDbPath(storeDbDir());
  if (dbPath === null) {
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

  const storeHandle = openLockedReadOnlyStoreDatabase(dbPath, SQLITE_WAIT_DEADLINE_MS);
  try {
    try {
      const storedFingerprint = storeHandle.get(
        "SELECT value FROM meta WHERE key = 'store_format_fingerprint' LIMIT 1",
      )?.value;
      if (storedFingerprint !== expectedFingerprint) {
        logSnapshotSkipped(projectDir, 'store format fingerprint mismatch', storeDiscardRemediation());
        return;
      }
    } catch (error) {
      if (isSqliteWaitBudgetExhausted(error)) throw error;
      logNoRelevantJobs(projectDir, {
        reason: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    let rows;
    try {
      rows = storeHandle.all(
        `SELECT job_id AS jobId, execution, phase
             FROM projection_jobs
            WHERE project_root = ?
            ORDER BY last_seq DESC
            LIMIT 20`,
        projectDir,
      );
    } catch (error) {
      if (isSqliteWaitBudgetExhausted(error)) throw error;
      logNoRelevantJobs(projectDir, {
        reason: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    let resultRows = [];
    const lookupBudgetMs = Math.floor(HOOK_WORK_DEADLINE_MS - performance.now());
    if (rows.some((row) => !isLivePhase(row.phase)) && lookupBudgetMs < MIN_RESULT_LOOKUP_MS) {
      logHookLine('pre-compact', 'terminal result paths omitted', { projectDir, reason: 'hook time budget exhausted' });
    } else if (rows.some((row) => !isLivePhase(row.phase))) {
      try {
        const bridgeDir = join(dirname(dirname(fileURLToPath(import.meta.url))), 'bridge');
        const listed = JSON.parse(execFileSync(join(bridgeDir, 'coral-cli'), ['jobs', 'list', '--all', '--json'], {
          cwd: projectDir,
          encoding: 'utf8',
          timeout: lookupBudgetMs,
          stdio: ['ignore', 'pipe', 'ignore'],
        }));
        if (Array.isArray(listed)) resultRows = listed;
      } catch {
        logHookLine('pre-compact', 'terminal result paths omitted', {
          projectDir,
          reason: 'terminal result paths are unavailable',
        });
      }
    }

    const jobs = rows.flatMap((row) => {
      if (
        typeof row.jobId !== 'string' ||
        !SAFE_JOB_ID.test(row.jobId) ||
        typeof row.phase !== 'string' ||
        (row.execution !== null && (!Number.isSafeInteger(row.execution) || row.execution < 1))
      ) {
        logSnapshotSkipped(
          projectDir,
          'projection_jobs contains an unsafe job identifier',
          "Run 'coral-cli backend shutdown' and report this projection integrity failure. Do not edit the database or discard the store solely because of this row.",
        );
        return [];
      }

      const resultPath = resultRows.find((result) => result?.jobId === row.jobId && result.execution === row.execution)?.resultPath ?? null;
      const hasArtifact = typeof resultPath === 'string' && existsSync(resultPath);
      if (!isLivePhase(row.phase) && !hasArtifact) {
        return [];
      }

      return [
        {
          jobId: row.jobId,
          execution: row.execution,
          phase: row.phase,
          resultPath,
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
    storeHandle.close();
  }
}, 'pre-compact');
