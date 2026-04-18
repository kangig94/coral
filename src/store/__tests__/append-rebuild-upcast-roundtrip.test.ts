import { describe, it } from 'vitest';

describe('append/rebuild upcast round-trip lock', () => {
  it.todo(
    'TODO Batch 2/3: enable after appendEvents + rebuildProjections land. Assert raw events.body_version/body stay at writer version while rebuild reducers receive the upcasted current body exactly once.',
  );
});
