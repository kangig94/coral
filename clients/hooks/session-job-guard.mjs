#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exitIfChildProcess, exitIfWrongFlavor, readStdin, writeHookOutput } from './lib/hook-utils.mjs';
import { projectDirFromInput } from './lib/plugin-paths.mjs';
import { jobGuardAlreadyBlocked, recordJobGuardBlock } from './lib/live-work-registry.mjs';

exitIfChildProcess();
exitIfWrongFlavor();

function jobInWaitScope(job, scopeRoot) {
  if (job.status.jobKind === 'kb') return true;
  const descendant = relative(scopeRoot, job.status.workDir);
  return descendant === '' || (!descendant.startsWith(`..${sep}`) && descendant !== '..' && !isAbsolute(descendant));
}

function waitCommand(jobs) {
  return `coral-cli jobs wait ${jobs.map((job) => job.jobId).join(' ')}`;
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
    Number.isSafeInteger(job.execution) && job.execution >= 1 &&
    (job.status?.jobKind === 'kb' || typeof job.status?.workDir === 'string'));
  if (jobs.length === 0) process.exit(0);
  if (jobGuardAlreadyBlocked(projectDir, input.session_id, jobs)) process.exit(0);

  const waitScope = realpathSync(input.cwd ?? projectDir);
  const inScopeJobs = [];
  const otherDirectories = new Map();
  for (const job of jobs) {
    if (jobInWaitScope(job, waitScope)) {
      inScopeJobs.push(job);
    } else {
      const group = otherDirectories.get(job.status.workDir) ?? [];
      group.push(job);
      otherDirectories.set(job.status.workDir, group);
    }
  }
  const commands = inScopeJobs.length > 0 ? [waitCommand(inScopeJobs)] : [];
  for (const [workDir, group] of otherDirectories) {
    commands.push(`cd '${workDir.replaceAll("'", "'\\''")}' && ${waitCommand(group)}`);
  }
  const waitInstruction = commands.length > 1
    ? `Run each command below separately to wait for them:\n${commands.join('\n')}`
    : `Run ${commands[0]} to wait for them.`;

  recordJobGuardBlock(projectDir, input.session_id, jobs);
  writeHookOutput({
    decision: 'block',
    reason: `${jobs.length} Coral job(s) launched in this session are still running with no wait attached. ${waitInstruction}`,
  });
} catch {
  process.exit(0);
}
