import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';

import { parseAgentSpec, parseAxisSpec, parseInputJson, parseKeyValuePairs } from '#src/cli/parse.js';

const originalStdinDescriptor = Object.getOwnPropertyDescriptor(process, 'stdin');

function restoreStdin(): void {
  if (originalStdinDescriptor) {
    Object.defineProperty(process, 'stdin', originalStdinDescriptor);
  }
}

afterEach(() => {
  restoreStdin();
});

describe('cli parse', () => {
  describe('parseKeyValuePairs', () => {
    it('keeps commas inside quoted values', () => {
      expect(parseKeyValuePairs('name=alice,persona="risk, cost, speed"')).toEqual({
        name: 'alice',
        persona: 'risk, cost, speed',
      });
    });

    it('throws when a segment is missing =', () => {
      expect(() => parseKeyValuePairs('name=alice,persona')).toThrow('Expected key=value segment');
    });

    it('throws on duplicate keys', () => {
      expect(() => parseKeyValuePairs('name=alice,name=bob')).toThrow('Duplicate key: name');
    });
  });

  describe('parseAgentSpec', () => {
    it('parses the minimal required fields', () => {
      expect(parseAgentSpec('name=alice,persona=critic')).toEqual({
        name: 'alice',
        persona: 'critic',
      });
    });
  });

  describe('parseAxisSpec', () => {
    it('parses axis followed by bare positions', () => {
      expect(parseAxisSpec('axis=topic,positions=a,b,c')).toEqual({
        axis: 'topic',
        positions: ['a', 'b', 'c'],
      });
    });

    it('throws when axis is missing', () => {
      expect(() => parseAxisSpec('positions=a,b,c')).toThrow('Axis spec requires axis');
    });
  });

  describe('parseInputJson', () => {
    it('accepts JSON from stdin and rejects file inputs', async () => {
      await expect(parseInputJson('payload.json')).rejects.toThrow('--input-json only accepts -');
      const stdin = new PassThrough();
      Object.defineProperty(process, 'stdin', {
        configurable: true,
        value: stdin as unknown as typeof process.stdin,
      });

      const parsedPromise = parseInputJson('-');
      stdin.end('{"topic":"risk","count":2}');

      await expect(parsedPromise).resolves.toEqual({
        topic: 'risk',
        count: 2,
      });
    });
  });
});
