import { join } from 'node:path';
export function sharedFixture(name: string): string {
  const directory = process.env.CORAL_TEST_SHARED_FIXTURES;
  if (!directory) throw new Error('Shared fixture globalSetup did not run.');
  return join(directory, `${name}.cjs`);
}
