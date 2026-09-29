import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';

import {
  publishLaunchAdmission,
  removeOwnLaunchAdmission,
  type LaunchAdmission,
} from '#src/infra/launch-admission-record.js';
import { probeProcessIncarnation, type ProcessIncarnation } from '#src/infra/node-process.js';

const [runDir, buildIdentity, purpose, parentPid, parentIncarnation, age, termPath] = process.argv.slice(2);
if (
  runDir === undefined ||
  buildIdentity === undefined ||
  purpose === undefined ||
  parentPid === undefined ||
  parentIncarnation === undefined ||
  age === undefined
)
  throw new Error('Missing inherited child fixture identity');
const incarnation = probeProcessIncarnation(process.pid);
if (incarnation === null) throw new Error('Fixture process incarnation is unavailable');
const launchId = randomUUID();
publishLaunchAdmission(runDir, {
  version: 1,
  launchId,
  child: { pid: process.pid, incarnation },
  parent: { pid: Number(parentPid), incarnation: parentIncarnation as ProcessIncarnation },
  admittedAt: Date.now() - Number(age),
  build: JSON.parse(buildIdentity) as LaunchAdmission['build'],
  purpose: purpose as 'startup' | 'succession',
});
process.on('exit', () => removeOwnLaunchAdmission(runDir, launchId));
if (termPath !== undefined) process.on('SIGTERM', () => writeFileSync(termPath, String(Date.now())));
setInterval(() => {}, 1_000);
