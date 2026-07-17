#!/usr/bin/env node
//
// subagent-track — maintains the subagent side of the per-session live-work
// registry that the ralph-loop and kb-promote-gate Stop hooks consult. Records a
// marker on SubagentStart, removes it on SubagentStop. Unconditional: the readers
// gate on the registry, this writer never decides whether a session cares.
//
import { exitIfChildProcess, exitIfWrongFlavor, readStdin } from './lib/hook-utils.mjs';
import { projectDirFromInput } from './lib/plugin-paths.mjs';
import { recordSubagentStart, recordSubagentStop } from './lib/live-work-registry.mjs';
exitIfChildProcess();
exitIfWrongFlavor();

try {
  const input = JSON.parse(await readStdin());
  const sessionId = input.session_id;
  const agentId = input.agent_id;
  if (!sessionId || !agentId) process.exit(0);

  const projectDir = projectDirFromInput(input);

  if (input.hook_event_name === 'SubagentStart') recordSubagentStart(projectDir, sessionId, agentId);
  else if (input.hook_event_name === 'SubagentStop') recordSubagentStop(projectDir, sessionId, agentId);
} catch {
  process.exit(0);
}
