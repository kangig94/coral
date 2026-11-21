#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exitIfChildProcess, exitIfWrongFlavor, readStdin, writeHookOutput } from './lib/hook-utils.mjs';
import { projectDirFromInput } from './lib/plugin-paths.mjs';
import { jobGuardAlreadyBlocked, recordJobGuardBlock } from './lib/live-work-registry.mjs';

const MAX_WAIT_JOB_IDS = 128;

exitIfChildProcess();
exitIfWrongFlavor();

function waitCommand(jobs) {
  return `coral-cli jobs wait ${jobs.map((job) => job.jobId).join(' ')}${jobs.length > 1 ? ' --all' : ''}`;
}

try {
  const input = JSON.parse(await readStdin());
  if (input.hook_event_name !== 'Stop' || typeof input.session_id !== 'string' || input.session_id.length === 0) {
    process.exit(0);
  }
  const projectDir = projectDirFromInput(input);

  const bridgeDir = join(dirname(dirname(fileURLToPath(import.meta.url))), 'bridge');
  const rows = JSON.parse(execFileSync(join(bridgeDir, 'coral-cli'), ['jobs', 'list', '--mine', '--unwaited', '--json'], {
    encoding: 'utf8',
    timeout: 2_000,
    stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, CORAL_OWNER: input.session_id, PATH: `${bridgeDir}:${process.env.PATH ?? ''}` },
  }));
  if (!Array.isArray(rows)) process.exit(0);
  const jobs = rows.filter((job) => typeof job?.jobId === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(job.jobId) &&
    Number.isSafeInteger(job.execution) && job.execution >= 1);
  if (jobs.length === 0) process.exit(0);
  if (jobGuardAlreadyBlocked(projectDir, input.session_id, jobs)) process.exit(0);

  const commands = [];
  for (let start = 0; start < jobs.length; start += MAX_WAIT_JOB_IDS) {
    commands.push(waitCommand(jobs.slice(start, start + MAX_WAIT_JOB_IDS)));
  }
  recordJobGuardBlock(projectDir, input.session_id, jobs);
  writeHookOutput({
    decision: 'block',
    reason: `${jobs.length} Coral job(s) launched in this session are still running with no wait attached. ` +
      (commands.length === 1
        ? `Run ${commands[0]} to wait for them.`
        : `Run each command below separately to wait for them.\n${commands.join('\n')}`),
  });
} catch {
  process.exit(0);
}
