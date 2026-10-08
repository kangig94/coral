#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exitIfChildProcess, exitIfWrongFlavor, readStdin, writeHookOutput } from './lib/hook-utils.mjs';
import { projectDirFromInput } from './lib/plugin-paths.mjs';
import { jobGuardAlreadyBlocked, recordJobGuardBlock } from './lib/live-work-registry.mjs';

exitIfChildProcess();
exitIfWrongFlavor();

try {
  const input = JSON.parse(await readStdin());
  if (input.hook_event_name !== 'Stop' || typeof input.session_id !== 'string' || input.session_id.length === 0) {
    process.exit(0);
  }
  const projectDir = projectDirFromInput(input);
  if (jobGuardAlreadyBlocked(projectDir, input.session_id)) process.exit(0);

  const bridgeDir = join(dirname(dirname(fileURLToPath(import.meta.url))), 'bridge');
  const jobs = JSON.parse(execFileSync(join(bridgeDir, 'coral-cli'), ['jobs', '--mine', '--unwaited', '--json'], {
    encoding: 'utf8',
    timeout: 2_000,
    stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, CORAL_OWNER: input.session_id, PATH: `${bridgeDir}:${process.env.PATH ?? ''}` },
  }));
  if (!Array.isArray(jobs) || jobs.length === 0 ||
      jobs.some((job) => typeof job?.jobId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(job.jobId))) process.exit(0);

  recordJobGuardBlock(projectDir, input.session_id);
  writeHookOutput({
    decision: 'block',
    reason: `${jobs.length} Coral job(s) launched in this session are still running with no wait attached. Run coral-cli wait jobs ${jobs.map((job) => job.jobId).join(' ')} to wait for them.`,
  });
} catch {
  process.exit(0);
}
