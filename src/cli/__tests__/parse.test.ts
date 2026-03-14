import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';

import {
  parseAgentSpec,
  parseAxisSpec,
  parseInputJson,
  parseKeyValuePairs,
} from '../parse.js';

const originalStdinDescriptor = Object.getOwnPropertyDescriptor(process, 'stdin');

function restoreStdin(): void {
  if (originalStdinDescriptor) {
    Object.defineProperty(process, 'stdin', originalStdinDescriptor);
  }
}

async function withMockStdin<T>(input: string, fn: () => Promise<T>): Promise<T> {
  const stdin = new PassThrough();
  Object.defineProperty(process, 'stdin', {
    configurable: true,
    value: stdin as unknown as typeof process.stdin,
  });

  try {
    const result = fn();
    stdin.end(input);
    return await result;
  } finally {
    restoreStdin();
  }
}

afterEach(() => {
  restoreStdin();
});

describe('cli parse', () => {
  describe('parseKeyValuePairs', () => {
    it('parses basic key=value pairs', () => {
      expect(parseKeyValuePairs('name=alice,persona=critic')).toEqual({
        name: 'alice',
        persona: 'critic',
      });
    });

    it('parses quoted values with spaces', () => {
      expect(parseKeyValuePairs('name=alice,persona="security expert"')).toEqual({
        name: 'alice',
        persona: 'security expert',
      });
    });

    it('keeps commas inside quoted values', () => {
      expect(parseKeyValuePairs('name=alice,persona="risk, cost, speed"')).toEqual({
        name: 'alice',
        persona: 'risk, cost, speed',
      });
    });

    it('throws when a segment is missing =', () => {
      expect(() => parseKeyValuePairs('name=alice,persona')).toThrow('Expected key=value segment');
    });

    it('throws on unclosed quotes', () => {
      expect(() => parseKeyValuePairs('name=alice,persona="security expert')).toThrow('Unclosed quote in spec');
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

    it('parses all supported fields', () => {
      expect(
        parseAgentSpec('name=alice,persona="security expert",participation=observer,provider=codex,model=gpt-5'),
      ).toEqual({
        name: 'alice',
        persona: 'security expert',
        participation: 'observer',
        provider: 'codex',
        model: 'gpt-5',
      });
    });

    it('throws when name is missing', () => {
      expect(() => parseAgentSpec('persona=critic')).toThrow('Agent spec requires name');
    });

    it('throws when persona is missing', () => {
      expect(() => parseAgentSpec('name=alice')).toThrow('Agent spec requires persona');
    });
  });

  describe('parseAxisSpec', () => {
    it('parses axis followed by bare positions', () => {
      expect(parseAxisSpec('axis=topic,positions=a,b,c')).toEqual({
        axis: 'topic',
        positions: ['a', 'b', 'c'],
      });
    });

    it('parses positions before axis', () => {
      expect(parseAxisSpec('positions=a,b,c,axis=topic')).toEqual({
        axis: 'topic',
        positions: ['a', 'b', 'c'],
      });
    });

    it('parses quoted positions', () => {
      expect(parseAxisSpec('axis=topic,positions="a,b,c"')).toEqual({
        axis: 'topic',
        positions: ['a', 'b', 'c'],
      });
    });

    it('parses a quoted axis value', () => {
      expect(parseAxisSpec('axis="my topic",positions=a,b')).toEqual({
        axis: 'my topic',
        positions: ['a', 'b'],
      });
    });

    it('throws when axis is missing', () => {
      expect(() => parseAxisSpec('positions=a,b,c')).toThrow('Axis spec requires axis');
    });

    it('throws when positions are missing', () => {
      expect(() => parseAxisSpec('axis=topic')).toThrow('Axis spec requires positions');
    });
  });

  describe('parseInputJson', () => {
    it('returns an empty object when the flag is undefined', async () => {
      await expect(parseInputJson(undefined)).resolves.toEqual({});
    });

    it('rejects non-stdin values', async () => {
      await expect(parseInputJson('payload.json')).rejects.toThrow('--input-json only accepts -');
    });

    it('reads and parses JSON from stdin when the flag is -', async () => {
      const parsed = await withMockStdin('{"topic":"risk","count":2}', () => parseInputJson('-'));

      expect(parsed).toEqual({
        topic: 'risk',
        count: 2,
      });
    });
  });
});
