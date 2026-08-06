import { describe, expect, it } from 'vitest';

import {
  decodeDurableCliProcessRuntimeMeta,
  durableCliProcessRuntimeMetaKey,
  encodeDurableCliProcessRuntimeMeta,
  type DurableCliProcessRuntimeMeta,
} from '#src/jobs/runtime-meta.js';

const JOB_ID = '11111111-1111-4111-8111-111111111111';
const META: DurableCliProcessRuntimeMeta = {
  version: 1,
  jobId: JOB_ID,
  pid: 4242,
  processStartedAtSeconds: 1_000,
};

describe('durable CLI process runtime meta', () => {
  it('keys on the job alone, since a durable CLI has no operation to key on', () => {
    expect(durableCliProcessRuntimeMetaKey(JOB_ID)).toBe(`durable_cli_process.v1:${JOB_ID}`);
  });

  it('refuses a non-canonical job id at the key boundary', () => {
    expect(() => durableCliProcessRuntimeMetaKey('not-a-uuid')).toThrow();
  });

  it('round-trips the recorded identity', () => {
    expect(decodeDurableCliProcessRuntimeMeta(encodeDurableCliProcessRuntimeMeta(META))).toEqual(META);
  });

  it('refuses to encode a record missing the start time that makes the pid meaningful', () => {
    const { processStartedAtSeconds: _dropped, ...withoutStart } = META;

    expect(() => encodeDurableCliProcessRuntimeMeta(withoutStart as DurableCliProcessRuntimeMeta)).toThrow(
      /schema validation/u,
    );
  });

  it.each([
    ['no row at all', null],
    ['an absent value', undefined],
    ['bytes that are not JSON', '{'],
    ['JSON of another shape', JSON.stringify({ version: 1, jobId: JOB_ID })],
    ['an unknown version', JSON.stringify({ ...META, version: 2 })],
  ])('decodes %s as no recorded identity rather than throwing', (_label, raw) => {
    // Every one of these means the same thing to the only caller that asks — there is nothing to check the
    // process against, so observation must answer `unknown`. Throwing would push that decision into a
    // `catch` at each call site and invite one of them to guess `absent` instead.
    expect(decodeDurableCliProcessRuntimeMeta(raw)).toBeNull();
  });
});
