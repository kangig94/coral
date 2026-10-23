import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { commitJobInput } from '#tests/helpers/job-commits.js';
import { createTerminalExportFixture } from '#tests/helpers/terminal-export.js';

const fixtures: ReturnType<typeof createTerminalExportFixture>[] = [];

function fixture() {
  const f = createTerminalExportFixture();
  fixtures.push(f);
  return f;
}

afterEach(() => {
  for (const f of fixtures.splice(0)) f.close();
});

describe('terminal result rendering', () => {
  it('exports the activation uncertainty warning and durable inspection command', () => {
    const f = fixture();
    const [progress] = commitJobInput(f.store, {
      type: 'job.execution.progress',
      stream: { kind: 'job', id: f.jobId },
      refs: { jobId: f.jobId },
      body: {
        execution: 1,
        kind: 'domain',
        stage: 'provider_operation_failed',
        message: 'Provider containment disappeared after activation may have begun.',
        detail: { code: 'activation_indeterminate' },
      },
    });
    if (progress === undefined) throw new Error('Missing provider failure evidence');
    f.complete({
      terminal: {
        content: '',
        durationMs: 1,
        outcome: { kind: 'failed', causeRef: { stream: progress.stream, seq: progress.seq } },
      },
    });
    f.store.publishTerminalResult(f.jobId);

    expect(readFileSync(f.resultPath, 'utf8')).toBe(
      'Failed: Provider containment disappeared after activation may have begun. ' +
        'Activation indeterminate [activation_indeterminate]: the provider may have started. ' +
        `Run \`coral-cli jobs detail ${f.jobId}\` to inspect the durable job record before deciding whether to retry.\n`,
    );
  });
});
