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
      jobs.some((job) => typeof job?.jobId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(job.jobId) ||
        (job.status?.jobKind !== 'kb' && typeof job.status?.workDir !== 'string'))) process.exit(0);

  const waitScope = realpathSync(input.cwd ?? projectDir);
  const inScopeIds = [];
  const otherDirectories = new Map();
  for (const job of jobs) {
    if (jobInWaitScope(job, waitScope)) {
      inScopeIds.push(job.jobId);
    } else {
      const ids = otherDirectories.get(job.status.workDir) ?? [];
      ids.push(job.jobId);
      otherDirectories.set(job.status.workDir, ids);
    }
  }
  const commands = inScopeIds.length > 0 ? [`coral-cli wait jobs ${inScopeIds.join(' ')}`] : [];
  for (const [workDir, ids] of otherDirectories) {
    commands.push(`cd '${workDir.replaceAll("'", "'\\''")}' && coral-cli wait jobs ${ids.join(' ')}`);
  }
  const waitInstruction = commands.length > 1
    ? `Run each command below separately to wait for them:\n${commands.join('\n')}`
    : `Run ${commands[0]} to wait for them.`;

  recordJobGuardBlock(projectDir, input.session_id);
  writeHookOutput({
    decision: 'block',
    reason: `${jobs.length} Coral job(s) launched in this session are still running with no wait attached. ${waitInstruction}`,
  });
} catch {
  process.exit(0);
}
