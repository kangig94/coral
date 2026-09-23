import { describe, expect, it, vi } from 'vitest';

import type { AppendedEvent } from '#src/store/append.js';
import { observeTerminalResultExports } from '#src/jobs/terminal/export.js';

function appended(overrides: Partial<AppendedEvent> & Pick<AppendedEvent, 'type' | 'stream'>): AppendedEvent {
  return {
    seq: 1,
    ts: '2026-09-23T00:00:00.000Z',
    namespace: 'namespace',
    project: '/project',
    body: {},
    ...overrides,
  } as AppendedEvent;
}

describe('observeTerminalResultExports', () => {
  it('renders one export per committed job terminal', () => {
    const rendered: string[] = [];
    observeTerminalResultExports((jobId) => {
      rendered.push(jobId);
      return `/exports/${jobId}/result.md`;
    })([
      appended({ type: 'job.launch.requested', stream: { kind: 'job', id: 'job-a' } }),
      appended({ type: 'job.terminal.recorded', stream: { kind: 'job', id: 'job-a' } }),
      appended({ type: 'job.progress.emitted', stream: { kind: 'job', id: 'job-b' } }),
      appended({ type: 'job.terminal.recorded', stream: { kind: 'job', id: 'job-b' } }),
    ]);

    expect(rendered).toEqual(['job-a', 'job-b']);
  });

  it('ignores a terminal recorded on another stream kind', () => {
    const ensure = vi.fn(() => '/unused');
    observeTerminalResultExports(ensure)([
      appended({ type: 'job.terminal.recorded', stream: { kind: 'session', id: 'session-a' } }),
    ]);

    expect(ensure).not.toHaveBeenCalled();
  });

  it('keeps rendering the batch after one job fails to write', () => {
    const rendered: string[] = [];
    observeTerminalResultExports((jobId) => {
      if (jobId === 'job-a') throw new Error('disk full');
      rendered.push(jobId);
      return `/exports/${jobId}/result.md`;
    })([
      appended({ type: 'job.terminal.recorded', stream: { kind: 'job', id: 'job-a' } }),
      appended({ type: 'job.terminal.recorded', stream: { kind: 'job', id: 'job-b' } }),
    ]);

    expect(rendered).toEqual(['job-b']);
  });
});
