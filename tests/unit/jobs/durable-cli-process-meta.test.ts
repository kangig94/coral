import { testIncarnation } from '#tests/helpers/process-incarnation.js';
import { describe, expect, it } from 'vitest';

import { encodeDurableCliProcessRuntimeMeta, type DurableCliProcessRuntimeMeta } from '#src/jobs/runtime-meta.js';

const JOB_ID = '11111111-1111-4111-8111-111111111111';
const META: DurableCliProcessRuntimeMeta = {
  jobId: JOB_ID,
  pid: 4242,
  incarnation: testIncarnation(1_000),
  processGroupId: 4242,
  childRoot: { pid: 4243, incarnation: testIncarnation(1_001) },
};

describe('durable CLI process runtime meta', () => {
  it('refuses to encode a record missing the child root that keeps wrapper death from proving absence', () => {
    const { childRoot: _dropped, ...withoutChildRoot } = META;

    expect(() => encodeDurableCliProcessRuntimeMeta(withoutChildRoot as DurableCliProcessRuntimeMeta)).toThrow(
      /schema validation/u,
    );
  });
});
