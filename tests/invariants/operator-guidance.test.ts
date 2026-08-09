import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

function readProjectFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

describe('operator guidance', () => {
  it('documents cursor-free initial wait retry exhaustion on every hook surface', () => {
    expect(readProjectFile('docs/hooks.md')).toContain(
      'cursor-free if the initial `backend_recovering` or `backend_shutting_down` subscription attempts exhaust',
    );
    expect(readProjectFile('clients/hooks/post-compact.mjs')).toContain(
      'the cursor can be absent when initial backend recovery/shutdown retries exhaust',
    );
    expect(readProjectFile('clients/hooks/bash-rewrite.mjs')).toContain(
      'can be cursor-free when initial backend recovery/shutdown retries',
    );
  });

  it('classifies delegated preplan waits before reading a terminal artifact', () => {
    const skill = readProjectFile('clients/skills/preplan/SKILL.md');
    const wait = skill.indexOf('terminal = Bash(`coral-cli wait jobs ${job} --embed`)');
    const stillWaiting = skill.indexOf('if terminal begins `Still waiting`', wait);
    const remediation = skill.indexOf('if terminal prints `remediation: <command>`', wait);
    const resultPath = skill.indexOf('if terminal contains `Result path: <path>`', wait);
    const artifactRead = skill.indexOf('output = Read(<path>)', wait);

    expect(wait).toBeGreaterThan(-1);
    expect(stillWaiting).toBeGreaterThan(wait);
    expect(remediation).toBeGreaterThan(stillWaiting);
    expect(resultPath).toBeGreaterThan(remediation);
    expect(artifactRead).toBeGreaterThan(resultPath);
  });
});
