import { expect, it } from 'vitest';
import { BackendToolHttpError } from '#src/transport/http/errors.js';
import { buildErrorEnvelope } from '#src/cli/errors.js';
import { formatErrorEnvelope } from '#src/cli/format/error.js';
import { formatKbRead, formatKbSearch } from '#src/cli/format/kb.js';
import { formatWaitTerminal } from '#src/cli/format/wait.js';

it('emits parseable KB search and read JSON', () => {
  expect(JSON.parse(formatKbSearch({ results: [], mode: 'text', retrievalDiagnostics: [] }))).toMatchObject({
    count: 0,
    results: [],
  });
  const note = {
    kind: 'note' as const,
    note: 'read-test',
    title: 'Read Test',
    content: '## Rule\nContent.',
    tags: [],
    principles: [],
  };
  expect(JSON.parse(formatKbRead(note))).toMatchObject(note);
});

it('keeps error tags on the first line', () => {
  const output = formatErrorEnvelope({ error: true, code: 'bad_request', message: 'line one\nline two' }, 400);
  expect(output.split('\n')[0]).toContain('[code=bad_request, http=400]');
});

it('does not print credentials or store paths from error diagnostics', () => {
  const secret = 'sk-proj-private';
  const storePath = '/private/operator/store.db';
  const error = new BackendToolHttpError('HTTP 503', 503, {
    code: 'backend_recovering',
    message: 'Recovery pending',
    detail: { secret, storePath },
  });
  const { envelope } = buildErrorEnvelope(error);
  const output = formatErrorEnvelope(envelope, error.statusCode);
  expect(output).not.toContain(secret);
  expect(output).not.toContain(storePath);
  expect(output).toContain('backend_recovering');
});

it('includes every remaining job in the wait continuation', () => {
  const output = formatWaitTerminal(
    {
      type: 'terminal',
      jobId: 'finished',
      seq: 5,
      remainingJobIds: ['job-a', 'job-b', 'job-c'],
      resultPath: '/tmp/result.md',
      result: { content: '', durationMs: 0, outcome: { kind: 'completed' } },
    },
    null,
    false,
  );
  expect(output).toContain('coral-cli wait jobs job-a job-b job-c');
});
