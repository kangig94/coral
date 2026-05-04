import { describe, expect, it } from 'vitest';

import { fileSyntaxDetector } from '#src/kb/corpus/rescan/incidents/file-syntax.js';
import type { CorpusMarkdownFileScan } from '#src/kb/corpus/rescan/scan.js';

function noteScan(body: string): CorpusMarkdownFileScan {
  // Minimal scan shape — only `content` and `frontmatter.bodyOffset` are
  // consumed by `detectMalformedMarkdown`. Body starts at offset 0 (no
  // frontmatter prefix in these focused cases).
  return {
    kind: 'note',
    slug: 'fixture',
    path: '/virtual/notes/fixture.md',
    entryId: 'note:fixture',
    activeEntryId: null,
    content: body,
    frontmatter: {
      status: 'absent',
      rawBlock: null,
      record: null,
      typed: null,
      typedError: null,
      error: null,
      bodyOffset: 0,
    },
    title: null,
    titleError: null,
  };
}

function detect(body: string) {
  return fileSyntaxDetector.detect({
    markdownFiles: [noteScan(body)],
    entityGraph: null,
    activeEntryIds: new Set(),
    principleSlugs: new Set(),
  });
}

describe('fileSyntaxDetector ATX heading detection', () => {
  it.each([
    ['# Title', 'single-hash heading with space'],
    ['## Rule', 'double-hash heading with space'],
    ['### Why', 'triple-hash heading with space'],
    ['###### H6', 'six-hash heading with space'],
    ['Plain text without leading hash', 'plain prose'],
  ])('does not flag %s as malformed (%s)', (line) => {
    const incidents = detect(line);
    const atx = incidents.flatMap((i) => {
      const signals = i.signals as { atxHeaders?: unknown };
      return signals.atxHeaders === undefined ? [] : [signals.atxHeaders];
    });
    expect(atx).toEqual([]);
  });

  it.each([
    ['##Rule', 'two hashes with no space'],
    ['###Why', 'three hashes with no space'],
    ['######H6NoSpace', 'six hashes with no space'],
  ])('flags %s as malformed (%s)', (line) => {
    const incidents = detect(line);
    const atx = incidents.flatMap((i) => {
      const signals = i.signals as { atxHeaders?: Array<{ line: number; text: string }> };
      return signals.atxHeaders ?? [];
    });
    expect(atx).toEqual([{ line: 1, text: line }]);
  });

  it('detects malformed and well-formed headings independently across a multi-line body', () => {
    const body = ['# Title', '', '## Section A', '', '##NoSpaceHeading', '', '### Section B'].join('\n');
    const incidents = detect(body);
    const atx = incidents.flatMap((i) => {
      const signals = i.signals as { atxHeaders?: Array<{ line: number; text: string }> };
      return signals.atxHeaders ?? [];
    });
    expect(atx).toEqual([{ line: 5, text: '##NoSpaceHeading' }]);
  });
});
