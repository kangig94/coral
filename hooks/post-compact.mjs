#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exitIfChildProcess, readStdin } from './lib/hook-utils.mjs';
exitIfChildProcess();

const JOBS_DIR = join(tmpdir(), 'coral-jobs');
const LIVE_PHASES = new Set(['queued', 'launching', 'running']);
const SNAPSHOT_PREFIX = 'active-jobs-';
const SNAPSHOT_SUFFIX = '.json';
const SNAPSHOT_TTL_MS = 10 * 60_000;

try {
  const input = JSON.parse(await readStdin());
  const projectRoot = process.env.CLAUDE_PROJECT_DIR ?? input.cwd;
  if (!projectRoot) process.exit(0);

  const projectSlug = projectRoot.replace(/\//g, '-');
  const snapshotDir = join(tmpdir(), 'coral', projectSlug);
  if (!existsSync(snapshotDir)) process.exit(0);
  if (!statSync(snapshotDir).isDirectory()) process.exit(0);

  const snapshotFiles = readdirSync(snapshotDir)
    .filter((fileName) => fileName.startsWith(SNAPSHOT_PREFIX) && fileName.endsWith(SNAPSHOT_SUFFIX));
  if (snapshotFiles.length === 0) process.exit(0);

  const now = Date.now();
  const freshSnapshots = [];

  for (const fileName of snapshotFiles) {
    const filePath = join(snapshotDir, fileName);

    let snapshot;
    try {
      snapshot = JSON.parse(readFileSync(filePath, 'utf-8'));
    } catch {
      safeUnlink(filePath);
      continue;
    }

    if (!isSnapshotRecord(snapshot)) {
      safeUnlink(filePath);
      continue;
    }

    if (snapshot.projectRoot !== projectRoot) {
      safeUnlink(filePath);
      continue;
    }

    if (now - snapshot.capturedAtMs > SNAPSHOT_TTL_MS) {
      safeUnlink(filePath);
      continue;
    }

    freshSnapshots.push({ fileName, snapshot });
  }

  if (freshSnapshots.length === 0) process.exit(0);

  freshSnapshots.sort((left, right) => (
    left.snapshot.capturedAtMs - right.snapshot.capturedAtMs
    || left.fileName.localeCompare(right.fileName)
  ));

  const jobsById = new Map();
  for (const { snapshot } of freshSnapshots) {
    for (const rawJob of snapshot.jobs) {
      const job = normalizeSnapshotJob(rawJob);
      if (!job) continue;
      jobsById.set(job.jobId, job);
    }
  }

  if (jobsById.size === 0) process.exit(0);

  const pending = [];
  const terminal = [];
  const missing = [];
  const unreadable = [];

  for (const job of jobsById.values()) {
    try {
      const state = readStatusState(job.jobId);

      if (state.kind === 'missing') {
        missing.push(job);
        continue;
      }

      if (state.kind === 'unreadable') {
        unreadable.push(job);
        continue;
      }

      if (!isStatusRecord(state.status, job.jobId)) {
        unreadable.push(job);
        continue;
      }

      if (LIVE_PHASES.has(state.status.phase)) {
        pending.push({ job, status: state.status });
        continue;
      }

      const isWorkflow = state.status.jobKind === 'workflow' || state.status.result?.workflow != null;
      const jobResultPath = join(JOBS_DIR, job.jobId, 'result.md');

      terminal.push({
        job,
        status: state.status,
        isWorkflow,
        jobResultPath,
        hasArtifact: hasFile(jobResultPath),
      });
    } catch {
      unreadable.push(job);
    }
  }

  if (pending.length === 0 && terminal.length === 0 && missing.length === 0 && unreadable.length === 0) {
    process.exit(0);
  }

  pending.sort((left, right) => left.job.jobId.localeCompare(right.job.jobId));
  terminal.sort((left, right) => left.job.jobId.localeCompare(right.job.jobId));
  missing.sort((left, right) => left.jobId.localeCompare(right.jobId));
  unreadable.sort((left, right) => left.jobId.localeCompare(right.jobId));

  const lines = ['Compaction recovery — project jobs:'];

  if (pending.length > 0) {
    lines.push('', 'Pending:');

    for (const { job, status } of pending) {
      const provider = typeof status.provider === 'string' ? status.provider : job.provider;
      const sessionId = typeof status.sessionId === 'string' ? status.sessionId : job.sessionId;
      lines.push(`- ${job.jobId} (${status.phase}, ${provider}, session: ${sessionId})`);
    }

    const pendingJobIds = pending.map(({ job }) => job.jobId).join(',');
    lines.push(`Run coral-cli wait --jobs ${pendingJobIds} --output-format json to resume monitoring.`);
  }

  if (terminal.length > 0) {
    lines.push('', 'Completed during compaction:');

    for (const entry of terminal) {
      const provider = entry.isWorkflow
        ? 'workflow'
        : (typeof entry.status.provider === 'string' ? entry.status.provider : entry.job.provider);

      if (entry.hasArtifact) {
        lines.push(`- ${entry.job.jobId} (${entry.status.phase}, ${provider}). Read ${entry.jobResultPath} for results.`);
        continue;
      }

      if (!entry.isWorkflow) {
        lines.push(`- ${entry.job.jobId} (${entry.status.phase}, ${provider}). Use coral-cli wait --jobs ${JSON.stringify(entry.job.jobId)} --output-format json --embed to attempt replay. Read event.result.content from the terminal JSON line if present; otherwise Read(event.result.path) for the full artifact.`);
        continue;
      }

      lines.push(`- ${entry.job.jobId} (${entry.status.phase}, workflow). Result artifact not found; inspect job directory manually.`);
    }
  }

  if (missing.length > 0 || unreadable.length > 0) {
    lines.push('', 'Status unavailable:');

    for (const job of missing) {
      lines.push(`- ${job.jobId} (snapshot phase: ${job.phase}). status.json is missing — do not call coral-cli wait unless a verified result artifact path exists.`);
    }

    for (const job of unreadable) {
      lines.push(`- ${job.jobId} (snapshot phase: ${job.phase}). status.json is unreadable — do not call coral-cli wait unless a verified result artifact path exists.`);
    }
  }

  if (lines.length === 1) process.exit(0);

  const additionalContext = lines.join('\n');
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext,
    },
  }));
} catch {
  process.exit(0);
}

function isSnapshotRecord(value) {
  return Boolean(
    value
      && typeof value === 'object'
      && Number.isFinite(value.capturedAtMs)
      && typeof value.projectRoot === 'string'
      && Array.isArray(value.jobs),
  );
}

function normalizeSnapshotJob(value) {
  if (!value || typeof value !== 'object' || typeof value.jobId !== 'string') {
    return null;
  }

  return {
    jobId: value.jobId,
    phase: typeof value.phase === 'string' ? value.phase : 'unknown',
    provider: typeof value.provider === 'string' ? value.provider : 'unknown',
    sessionId: typeof value.sessionId === 'string' ? value.sessionId : 'unknown',
  };
}

function hasFile(filePath) {
  try {
    return existsSync(filePath) && statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function isStatusRecord(value, jobId) {
  return Boolean(
    value
      && typeof value === 'object'
      && value.jobId === jobId
      && typeof value.sessionId === 'string'
      && typeof value.provider === 'string'
      && typeof value.phase === 'string',
  );
}

function safeUnlink(filePath) {
  try {
    unlinkSync(filePath);
  } catch {
    // fail-open cleanup
  }
}

function readStatusState(jobId) {
  try {
    return {
      kind: 'ok',
      status: JSON.parse(readFileSync(join(JOBS_DIR, jobId, 'status.json'), 'utf-8')),
    };
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      return { kind: 'missing' };
    }
    return { kind: 'unreadable' };
  }
}
