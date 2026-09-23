#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  exitIfChildProcess,
  exitIfWrongFlavor,
  failOpen,
  buildFlavor,
  logHookLine,
  readStdin,
  sweepStale,
  writeHookOutput,
} from './lib/hook-utils.mjs';
import { isLivePhase, SNAPSHOT_PREFIX, SNAPSHOT_SUFFIX, SNAPSHOT_TTL_MS } from './lib/jobs-state.mjs';
import { exportsJobsDir, projectDirFromInput, projectTmpDir } from './lib/plugin-paths.mjs';

exitIfChildProcess();
exitIfWrongFlavor();

function snapshotDirForProject(projectDir) {
  return join(projectTmpDir(projectDir), 'hooks');
}

function readLatestSnapshotPath(snapshotDir) {
  if (!existsSync(snapshotDir)) {
    return null;
  }

  const entries = readdirSync(snapshotDir)
    .filter((name) => name.startsWith(SNAPSHOT_PREFIX) && name.endsWith(SNAPSHOT_SUFFIX))
    .sort()
    .reverse();
  return entries.length > 0 ? join(snapshotDir, entries[0]) : null;
}

function isSnapshotJob(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof value.jobId === 'string' &&
    /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value.jobId) &&
    typeof value.phase === 'string' &&
    typeof value.hasResult === 'boolean'
  );
}

await failOpen(async () => {
  const input = JSON.parse((await readStdin()) || '{}');
  const projectDir = resolve(projectDirFromInput(input, process.cwd()));
  const snapshotDir = snapshotDirForProject(projectDir);
  sweepStale(snapshotDir, SNAPSHOT_PREFIX, SNAPSHOT_TTL_MS);

  const snapshotPath = readLatestSnapshotPath(snapshotDir);
  if (!snapshotPath) {
    logHookLine('post-compact', 'no compact snapshot found', { projectDir });
    return;
  }

  const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'));
  try {
    unlinkSync(snapshotPath);
  } catch {
    // best-effort cleanup
  }

  if (
    snapshot?.version !== 1 ||
    snapshot.projectDir !== projectDir ||
    !Number.isFinite(snapshot.capturedAtMs) ||
    !Array.isArray(snapshot.jobs) ||
    !snapshot.jobs.every(isSnapshotJob)
  ) {
    logHookLine('post-compact', 'rejected invalid compact snapshot', { projectDir, snapshotPath });
    return;
  }
  const jobs = snapshot.jobs;
  const liveJobs = jobs.filter((job) => isLivePhase(job.phase));
  const terminalJobs = jobs
    .filter((job) => !isLivePhase(job.phase) && job.hasResult)
    .map((job) => ({
      ...job,
      resultPath: join(exportsJobsDir(buildFlavor()), job.jobId, 'result.md'),
    }))
    .filter((job) => existsSync(job.resultPath));

  if (liveJobs.length === 0 && terminalJobs.length === 0) {
    logHookLine('post-compact', 'snapshot contained no recoverable jobs', { snapshotPath });
    return;
  }

  const bridge = 'coral-cli';
  const lines = ['Compact recovery snapshot:', ''];

  if (liveJobs.length > 0) {
    const jobIds = liveJobs.map((job) => job.jobId).join(' ');
    lines.push('Jobs were still active before compaction.');
    lines.push(`Run: ${bridge} wait jobs ${jobIds}`);
    lines.push('');
  }

  if (terminalJobs.length > 0) {
    lines.push('Recent terminal jobs still have readable result artifacts:');
    for (const job of terminalJobs) {
      lines.push(`- ${job.jobId}: ${job.resultPath}`);
    }
    lines.push('');
    lines.push('For inline preview, rerun one job with:');
    lines.push(`- ${bridge} wait jobs <job-id> --embed`);
  }

  lines.push(
    'Wait exit codes: a nonzero mapped terminal code returns as-is (1 = failed, aborted, or faulted; provider_exit uses its normalized child code), even when siblings remain; ' +
      'a zero terminal code returns 0 when no requested siblings remain, or 75 with a continuation command when siblings remain; ' +
      'nonterminal 75 = requested work remains with a continuation command (the cursor can be absent when initial backend recovery/shutdown retries exhaust); ' +
      'provider_exit(75) may instead be terminal 75 with no continuation.',
  );

  writeHookOutput({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: lines.join('\n'),
    },
  });
  logHookLine('post-compact', 'recovered compact snapshot', {
    projectDir,
    liveJobs: liveJobs.length,
    terminalJobs: terminalJobs.length,
  });
}, 'post-compact');
