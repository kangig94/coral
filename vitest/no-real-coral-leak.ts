import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import type { TestProject } from 'vitest/node';

export default function setup(project: TestProject): () => void {
  const reports = mkdtempSync(join(tmpdir(), 'coral-write-guard-'));
  project.config.env.CORAL_TEST_WRITE_GUARD = JSON.stringify({
    root: join(userInfo().homedir, '.coral'),
    reports,
  });
  return () => {
    const violations = readdirSync(reports).map((file) => readFileSync(join(reports, file), 'utf8'));
    rmSync(reports, { recursive: true, force: true });
    if (violations.length) {
      throw new Error(`Tests attempted writes into the real ~/.coral tree:\n${violations.join('')}`);
    }
  };
}
