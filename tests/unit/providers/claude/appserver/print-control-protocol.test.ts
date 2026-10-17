import { describe, expect, it } from 'vitest';

import { parseClaudePrintStdoutLine } from '#src/providers/claude/appserver/print-control-protocol.js';

const replay = {
  type: 'user',
  message: { role: 'user', content: 'Additional instruction' },
  session_id: 'ced07382-1111-4111-8111-111111111111',
  parent_tool_use_id: null,
  uuid: '22222222-2222-4222-8222-222222222222',
  timestamp: '2026-10-17T14:14:45.813Z',
  isReplay: true,
};

describe('parseClaudePrintStdoutLine', () => {
  it('surfaces validated user replays with the echoed UUID', () => {
    expect(parseClaudePrintStdoutLine(JSON.stringify(replay))).toEqual(replay);
    const blocks = { ...replay, message: { role: 'user', content: [{ type: 'text', text: 'same input' }] } };
    expect(parseClaudePrintStdoutLine(JSON.stringify(blocks))).toEqual(blocks);
  });

  it.each([
    { isReplay: false },
    { isReplay: 'true' },
    { isReplay: undefined },
    { uuid: undefined },
    { uuid: 'not-a-uuid' },
    { message: { role: 'assistant', content: 'hello' } },
    { message: { role: 'user', content: null } },
    { message: { role: 'user', content: [{ type: 'text', text: 42 }] } },
    { message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'done' }] } },
  ])('rejects malformed replay fields: %j', (override) => {
    expect(parseClaudePrintStdoutLine(JSON.stringify({ ...replay, ...override }))).toBeNull();
  });

  it('discards ordinary tool-result user frames even when they carry a UUID', () => {
    expect(
      parseClaudePrintStdoutLine(
        JSON.stringify({
          ...replay,
          isReplay: undefined,
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'done' }] },
        }),
      ),
    ).toBeNull();
  });
});
