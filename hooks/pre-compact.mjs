#!/usr/bin/env node

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { exitIfChildProcess, exitIfWrongFlavor, readStdin } from './lib/hook-utils.mjs';
import { JOBS_DIR, projectTmpDir } from './lib/plugin-paths.mjs';
import { isLivePhase, snapshotFileName } from './lib/jobs-state.mjs';
exitIfChildProcess();
exitIfWrongFlavor();

try {
  const input = JSON.parse(await readStdin());
  const projectRoot = process.env.CLAUDE_PROJECT_DIR ?? input.cwd;
  if (!projectRoot) process.exit(0);

  const sourceSessionId = input.session_id;
  if (!existsSync(JOBS_DIR)) process.exit(0);

  const jobs = [];

  for (const entry of readdirSync(JOBS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;

    const status = safeReadStatus(entry.name);
    if (!status) continue;
    if (status.projectRoot !== projectRoot) continue;
    if (!isLivePhase(status.phase)) continue;
    if (typeof status.jobId !== 'string') continue;
    if (typeof status.sessionId !== 'string') continue;

    jobs.push({
      jobId: status.jobId,
      phase: status.phase,
      provider: status.provider,
      sessionId: status.sessionId,
      jobKind: status.jobKind,
    });
  }

  if (jobs.length === 0) process.exit(0);

  const snapshotDir = projectTmpDir(projectRoot);
  const capturedAtMs = Date.now();
  mkdirSync(snapshotDir, { recursive: true });

  const snapshotPath = join(
    snapshotDir,
    snapshotFileName(capturedAtMs, randomBytes(4).toString('hex')),
  );

  writeFileSync(snapshotPath, JSON.stringify({
    capturedAtMs,
    projectRoot,
    sourceSessionId: sourceSessionId ?? null,
    jobs,
  }, null, 2));
} catch {
  process.exit(0);
}

function safeReadStatus(jobId) {
  try {
    return JSON.parse(readFileSync(join(JOBS_DIR, jobId, 'status.json'), 'utf-8'));
  } catch {
    return null;
  }
}
