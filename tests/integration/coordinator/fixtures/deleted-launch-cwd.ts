import { spawnAdmittedChild } from '#src/coordinator-launch/child-process.js';
import { SupervisorLaunchMemory } from '#src/coordinator-launch/state.js';
import { probeProcessIncarnation } from '#src/infra/node-process.js';
import { appendFileSync, rmSync } from 'node:fs';
import { setBackendLogSink } from '#src/infra/backend-log.js';

const [executable, runDir, invokingDir, removeRunDir, diagnosticPath] = process.argv.slice(2);
if (diagnosticPath !== undefined) setBackendLogSink((message) => appendFileSync(diagnosticPath, message));
const incarnation = probeProcessIncarnation(process.pid);
if (incarnation === null) throw new Error('Missing process incarnation');
const memory = new SupervisorLaunchMemory(runDir, { pid: process.pid, incarnation }, 'fixture');
const owner = memory.read().owner;
const reservation = memory.reserve(owner, 'fixture', 'startup');
if (reservation === null) throw new Error('Missing reservation');
rmSync(invokingDir, { recursive: true });
if (removeRunDir === '1') rmSync(runDir, { recursive: true });
const running = spawnAdmittedChild(
  memory,
  owner,
  reservation,
  executable,
  ['--print-store-format-fingerprint'],
  runDir,
);
if (running === null) process.exitCode = 1;
else
  running.child.once('exit', (code) => {
    process.exitCode = code ?? 1;
  });
