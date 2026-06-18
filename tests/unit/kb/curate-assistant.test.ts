import { describe, expect, it } from 'vitest';

import {
  CURATE_ASSISTANT_MODEL,
  CURATE_ASSISTANT_PERMISSION_MODE,
  type CurateAssistantPort,
} from '#src/kb/curate/assistant.js';
import { runCurateAssistant } from '#src/kb/curate/operations.js';

describe('curate assistant', () => {
  it('pins curate calls to Sonnet auto mode', async () => {
    let observed: Parameters<CurateAssistantPort['complete']>[0] | undefined;
    const assistant: CurateAssistantPort = {
      async complete(request) {
        observed = request;
        return 'ok';
      },
    };

    const signal = new AbortController().signal;
    await expect(runCurateAssistant(assistant, 'classify prompt', 'classification', signal)).resolves.toBe('ok');

    expect(observed).toEqual({
      prompt: 'classify prompt',
      purpose: 'classification',
      model: CURATE_ASSISTANT_MODEL,
      permissionMode: CURATE_ASSISTANT_PERMISSION_MODE,
      signal,
    });
  });

  it('uses auto mode for git conflict resolution', async () => {
    let observed: Parameters<CurateAssistantPort['complete']>[0] | undefined;
    const assistant: CurateAssistantPort = {
      async complete(request) {
        observed = request;
        return 'resolved';
      },
    };

    await expect(runCurateAssistant(assistant, 'resolve prompt', 'git-conflict-resolution')).resolves.toBe('resolved');

    expect(observed).toEqual({
      prompt: 'resolve prompt',
      purpose: 'git-conflict-resolution',
      model: CURATE_ASSISTANT_MODEL,
      permissionMode: CURATE_ASSISTANT_PERMISSION_MODE,
      signal: undefined,
    });
  });
});
