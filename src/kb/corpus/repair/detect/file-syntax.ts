import type { CorpusMarkdownFileScan, DetectedIncident, Detector } from '../corpus-scan.js';
import { REPAIR_INCIDENT_ID } from '../incident-ids.js';

const CONFLICT_MARKER_CANONICAL = REPAIR_INCIDENT_ID.FILE_SYNTAX.CONFLICT_MARKERS;
const MALFORMED_MARKDOWN_CANONICAL = REPAIR_INCIDENT_ID.FILE_SYNTAX.MALFORMED_MARKDOWN;

const CONFLICT_MARKER_PATTERN = /^(<<<<<<<|=======|>>>>>>>)(?: .*)?$/;
const FENCE_PATTERN = /^(?:```|~~~)[^\r\n]*$/;
const ATX_HEADER_NO_SPACE_PATTERN = /^#{1,6}\S/;
const SETEXT_UNDERLINE_PATTERN = /^(=+|-+)\s*$/;
const BLOCK_DELIMITER_PATTERN = /^(?:---|```|~~~|\*\*\*|___)\s*$/;

export const fileSyntaxDetector: Detector = {
  detect(corpus) {
    const incidents: DetectedIncident[] = [];

    for (const entry of corpus.markdownFiles) {
      const conflictMarkers = detectConflictMarkers(entry);
      if (conflictMarkers !== null) {
        incidents.push(conflictMarkers);
      }

      const malformedMarkdown = detectMalformedMarkdown(entry);
      if (malformedMarkdown !== null) {
        incidents.push(malformedMarkdown);
      }
    }

    return incidents;
  },
};

function detectConflictMarkers(entry: CorpusMarkdownFileScan): DetectedIncident | null {
  const matches = splitLines(entry.content)
    .map((line, index) => {
      if (!CONFLICT_MARKER_PATTERN.test(line)) {
        return null;
      }

      return {
        line: index + 1,
        marker: line.slice(0, 7),
        text: line,
      };
    })
    .filter((match): match is { line: number; marker: string; text: string } => match !== null);

  if (matches.length === 0) {
    return null;
  }

  return {
    locus: 'file-syntax',
    canonical: CONFLICT_MARKER_CANONICAL,
    entryId: entry.entryId,
    signals: {
      matches,
    },
  };
}

function detectMalformedMarkdown(entry: CorpusMarkdownFileScan): DetectedIncident | null {
  const body = entry.content.slice(entry.frontmatter.bodyOffset);
  const lines = splitLines(body);
  const bodyStartLine = lineNumberAtOffset(entry.content, entry.frontmatter.bodyOffset);

  let openFence: { line: number; marker: '```' | '~~~'; text: string } | null = null;
  const atxHeaders: Array<{ line: number; text: string }> = [];
  const setextUnderlines: Array<{ line: number; text: string; previousLine: string | null }> = [];

  for (const [index, line] of lines.entries()) {
    const lineNumber = bodyStartLine + index;

    if (FENCE_PATTERN.test(line)) {
      const marker = line.startsWith('```') ? '```' : '~~~';
      if (openFence === null) {
        openFence = { line: lineNumber, marker, text: line };
      } else if (openFence.marker === marker) {
        openFence = null;
      }
      continue;
    }

    if (openFence !== null) {
      continue;
    }

    if (ATX_HEADER_NO_SPACE_PATTERN.test(line)) {
      atxHeaders.push({
        line: lineNumber,
        text: line,
      });
    }

    if (!SETEXT_UNDERLINE_PATTERN.test(line)) {
      continue;
    }

    const previousLine = index === 0 ? null : lines[index - 1] ?? null;
    const invalidPreviousLine =
      previousLine === null ||
      previousLine.trim() === '' ||
      BLOCK_DELIMITER_PATTERN.test(previousLine.trim()) ||
      SETEXT_UNDERLINE_PATTERN.test(previousLine.trim());

    if (invalidPreviousLine) {
      setextUnderlines.push({
        line: lineNumber,
        text: line,
        previousLine,
      });
    }
  }

  if (openFence === null && atxHeaders.length === 0 && setextUnderlines.length === 0) {
    return null;
  }

  return {
    locus: 'file-syntax',
    canonical: MALFORMED_MARKDOWN_CANONICAL,
    entryId: entry.entryId,
    signals: {
      ...(openFence === null ? {} : { unmatchedFence: openFence }),
      ...(atxHeaders.length === 0 ? {} : { atxHeaders }),
      ...(setextUnderlines.length === 0 ? {} : { setextUnderlines }),
    },
  };
}

function splitLines(content: string): string[] {
  if (content.length === 0) {
    return [];
  }

  return content.split(/\r?\n/);
}

function lineNumberAtOffset(content: string, offset: number): number {
  if (offset <= 0) {
    return 1;
  }

  const prefix = content.slice(0, offset);
  const newlines = prefix.match(/\r?\n/g);
  return (newlines?.length ?? 0) + 1;
}
