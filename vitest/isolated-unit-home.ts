import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestProject } from 'vitest/node';
import { reapSharedFixtureStages } from '../tests/helpers/shared-fixtures.js';

export default function setup(project: TestProject): () => void {
  reapSharedFixtureStages();
  const home = mkdtempSync(
    join(project.config.env.TMPDIR ?? tmpdir(), `coral-${project.config.env.CORAL_TEST_TIER}-home-`),
  );
  Object.assign(project.config.env, { HOME: home, USERPROFILE: home, CORAL_TEST_HOME: home });
  return () => rmSync(home, { recursive: true, force: true });
}
