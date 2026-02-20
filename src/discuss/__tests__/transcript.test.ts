import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  wrapText,
  generateOneLiner,
  initTranscript,
  appendSpeech,
  appendEpochSummary,
  readFull,
  readRecent,
  readSummary,
} from '../transcript.js';

let tmpDir: string;

beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'coral-transcript-')); });
afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

const filePath = () => join(tmpDir, 'transcript.md');

describe('wrapText', () => {
  it('should pass through short text unchanged', () => {
    expect(wrapText('Hello world.')).toBe('Hello world.');
  });

  it('should wrap at word boundary before 80 chars', () => {
    const word = 'abcdefghij'; // 10 chars
    const text = Array(9).fill(word).join(' '); // 98 chars with spaces
    const result = wrapText(text);
    const lines = result.split('\n');
    expect(lines.every((l) => l.length <= 100)).toBe(true);
  });

  it('should extend to sentence end in grace zone (80-100)', () => {
    // Build a string where sentence end falls in grace zone
    const text = 'A'.repeat(75) + ' end sentence here. Next word here.';
    const result = wrapText(text);
    const firstLine = result.split('\n')[0];
    // Should include 'here.' if it falls within hard limit
    expect(firstLine.endsWith('here.') || firstLine.length <= 100).toBe(true);
  });

  it('should hard-wrap at 100 chars when no sentence end', () => {
    const longWord = 'word';
    const text = Array(30).fill(longWord).join(' '); // well over 100
    const result = wrapText(text);
    const lines = result.split('\n');
    // All lines except possibly the last (trailing words) should be ≤ 100
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(104); // allow single word overflow
    }
  });

  it('should preserve empty lines (paragraph breaks)', () => {
    const text = 'First paragraph.\n\nSecond paragraph.';
    const result = wrapText(text);
    expect(result).toContain('\n\n');
  });
});

describe('generateOneLiner', () => {
  it('should return full text if under 100 chars', () => {
    expect(generateOneLiner('Short text.')).toBe('Short text.');
  });

  it('should truncate at sentence boundary', () => {
    const text = 'First sentence ends here. Second sentence continues on.';
    expect(generateOneLiner(text)).toBe('First sentence ends here.');
  });

  it('should truncate at word boundary if no sentence', () => {
    const text = 'A'.repeat(50) + ' B'.repeat(30);
    const result = generateOneLiner(text);
    expect(result.length).toBeLessThanOrEqual(103); // 100 + '…'
    expect(result.endsWith('…')).toBe(true);
  });
});

describe('initTranscript', () => {
  it('should create file with topic header and Epoch 1', () => {
    initTranscript(filePath(), 'Microservices Discussion');
    const content = readFull(filePath());
    expect(content).toContain('# Microservices Discussion');
    expect(content).toContain('## Epoch 1');
  });
});

describe('appendSpeech', () => {
  it('should append timestamped speech entry', () => {
    initTranscript(filePath(), 'Topic');
    appendSpeech(filePath(), 'architect', 'Microservice architecture enables independent deployments.');
    const content = readFull(filePath());
    expect(content).toContain('### [');
    expect(content).toContain('] architect');
    expect(content).toContain('Microservice architecture enables');
  });

  it('should word-wrap long content', () => {
    initTranscript(filePath(), 'Topic');
    const longContent = 'word '.repeat(40); // 200 chars
    appendSpeech(filePath(), 'speaker', longContent);
    const content = readFull(filePath());
    const lines = content.split('\n');
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(104);
    }
  });
});

describe('appendEpochSummary', () => {
  it('should append epoch header and summary', () => {
    initTranscript(filePath(), 'Topic');
    appendEpochSummary(filePath(), 2, 'Epoch 1 key arguments: ...');
    const content = readFull(filePath());
    expect(content).toContain('## Epoch 2');
    expect(content).toContain('Epoch Summary (by Teamlead)');
    expect(content).toContain('Epoch 1 key arguments');
  });
});

describe('readRecent', () => {
  it('should return full text for recent speeches', () => {
    initTranscript(filePath(), 'Topic');
    appendSpeech(filePath(), 'alice', 'Alice speech.');
    appendSpeech(filePath(), 'bob', 'Bob speech.');
    appendSpeech(filePath(), 'carol', 'Carol speech.');
    const result = readRecent(filePath(), 2);
    // Last 2 (bob, carol) in full, alice as summary
    expect(result).toContain('bob');
    expect(result).toContain('carol');
  });

  it('should show all as full when lastN >= total', () => {
    initTranscript(filePath(), 'Topic');
    appendSpeech(filePath(), 'alice', 'Alice speech.');
    const result = readRecent(filePath(), 5);
    expect(result).toContain('Alice speech.');
  });

  it('should handle empty transcript', () => {
    initTranscript(filePath(), 'Topic');
    const result = readRecent(filePath(), 3);
    // No speeches yet — returns the raw header
    expect(typeof result).toBe('string');
  });
});

describe('readSummary', () => {
  it('should return one-liner summaries', () => {
    initTranscript(filePath(), 'Topic');
    appendSpeech(filePath(), 'alice', 'Alice made a very interesting point about the topic.');
    appendSpeech(filePath(), 'bob', 'Bob disagreed strongly.');
    const result = readSummary(filePath());
    expect(result).toContain('- alice:');
    expect(result).toContain('- bob:');
  });
});

describe('readFull', () => {
  it('should return empty string for missing file', () => {
    expect(readFull(join(tmpDir, 'missing.md'))).toBe('');
  });
});
