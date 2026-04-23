import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect } from 'vitest';

import { createKbRuntime } from '#src/kb/runtime.js';
import type { KbRuntime } from '#src/kb/contracts.js';
import { sortedMarkdownEntries } from '#src/kb/corpus/markdown-entries.js';
import { readCurateRetryQueue } from '#src/kb/curate/retry.js';
import { classifyIncident, type IncidentClassification } from '#src/kb/corpus/repair/classify.js';
import { fileSyntaxDetector } from '#src/kb/corpus/repair/detect/file-syntax.js';
import { frontmatterShapeDetector } from '#src/kb/corpus/repair/detect/frontmatter-shape.js';
import { identitySequenceDetector } from '#src/kb/corpus/repair/detect/identity-sequence.js';
import { referenceIntegrityDetector } from '#src/kb/corpus/repair/detect/reference-integrity.js';
import { REPAIR_HINTS, applyDetectedIncidentFixes } from '#src/kb/corpus/repair/fix.js';
import { repairIncidentLocus, type RepairIncidentId } from '#src/kb/corpus/repair/incident-ids.js';
import {
  createCorpusEntityGraphScan,
  createCorpusMarkdownFileScan,
  createCorpusScanView,
  type CorpusMarkdownKind,
  type DetectedIncident,
} from '#src/kb/corpus/repair/corpus-scan.js';

const FIXTURES_DIR = fileURLToPath(new URL('./fixtures', import.meta.url));
const DETECTORS = [
  fileSyntaxDetector,
  frontmatterShapeDetector,
  identitySequenceDetector,
  referenceIntegrityDetector,
] as const;

export interface RepairFixtureHarness {
  readonly fixture: string;
  readonly tempDir: string;
  readonly markdownRoot: string;
  readonly kb: KbRuntime;
  path(relativePath: string): string;
  readText(relativePath: string): string;
  detect(): DetectedIncident[];
  captureCorpusFiles(): Record<string, string>;
  cleanup(): void;
}

export interface ExpectedDetectedIncident {
  locus: DetectedIncident['locus'];
  canonical: RepairIncidentId;
  entryId: string;
  assertSignals(signals: DetectedIncident['signals']): void;
}

export interface RepairFixtureCase {
  fixture: string;
  classification: IncidentClassification;
  expectedIncidents: readonly ExpectedDetectedIncident[];
  assertFailure(harness: RepairFixtureHarness): void | Promise<void>;
  assertResolved?(harness: RepairFixtureHarness): void | Promise<void>;
}

export function createRepairFixtureHarness(fixture: string): RepairFixtureHarness {
  const tempDir = mkdtempSync(join(tmpdir(), 'coral-kb-repair-'));
  const markdownRoot = join(tempDir, 'vault');
  const runtimeDir = join(tempDir, 'runtime');

  cpSync(join(FIXTURES_DIR, fixture), markdownRoot, { recursive: true });

  const kb = createKbRuntime({
    markdownRoot,
    runtimeDir,
  });

  return {
    fixture,
    tempDir,
    markdownRoot,
    kb,
    path(relativePath: string): string {
      return join(markdownRoot, relativePath);
    },
    readText(relativePath: string): string {
      return readFileSync(join(markdownRoot, relativePath), 'utf-8');
    },
    detect(): DetectedIncident[] {
      return detectAllIncidents(markdownRoot);
    },
    captureCorpusFiles(): Record<string, string> {
      return captureTextFiles(markdownRoot);
    },
    cleanup(): void {
      rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

export function expectedDetectedIncident(input: {
  canonical: RepairIncidentId;
  entryId: string;
  assertSignals(signals: DetectedIncident['signals']): void;
}): ExpectedDetectedIncident {
  return {
    locus: repairIncidentLocus(input.canonical),
    canonical: input.canonical,
    entryId: input.entryId,
    assertSignals: input.assertSignals,
  };
}

export async function runRepairFixtureCase(testCase: RepairFixtureCase): Promise<void> {
  const harness = createRepairFixtureHarness(testCase.fixture);

  try {
    const beforeFixCorpus = harness.captureCorpusFiles();

    await testCase.assertFailure(harness);

    const detected = harness.detect();
    expectDetectedIncidents(detected, testCase.expectedIncidents);

    const classifications = detected.map((incident) => classifyIncident(incident));
    expect(classifications).toEqual(testCase.expectedIncidents.map(() => testCase.classification));

    const results = await applyDetectedIncidentFixes(detected, harness.kb);
    expect(results).toHaveLength(testCase.expectedIncidents.length);
    expect(results.map((result) => result.action)).toEqual(
      testCase.expectedIncidents.map(() => (testCase.classification === 'auto-fixable' ? 'fixed' : 'enqueued')),
    );

    if (testCase.classification === 'auto-fixable') {
      expect(readCurateRetryQueue(harness.kb)).toEqual([]);
      expect(harness.detect()).toEqual([]);
      await testCase.assertResolved?.(harness);
      return;
    }

    expect(harness.captureCorpusFiles()).toEqual(beforeFixCorpus);
    expectDetectedIncidents(harness.detect(), testCase.expectedIncidents);

    const retryQueue = readCurateRetryQueue(harness.kb);
    expect(retryQueue).toHaveLength(detected.length);

    for (const incident of detected) {
      const queued = retryQueue.find((entry) => entry.entryId === incident.entryId);
      expect(queued).toBeDefined();
      expect(queued?.reason).toBe(incident.canonical);
      expect(queued?.locus).toBe(incident.locus);
      expect(queued?.canonicalIncident).toBe(incident.canonical);
      expect(queued?.repairHint).toBe(REPAIR_HINTS[incident.canonical]);
      expect(queued?.retryCount).toBe(0);
      expect(Date.parse(queued?.detectedAt ?? '')).not.toBeNaN();
      expect(Date.parse(queued?.retryNotBefore ?? '')).not.toBeNaN();
      expect(JSON.parse(queued?.signalsJson ?? 'null')).toEqual(incident.signals);
    }
  } finally {
    harness.cleanup();
  }
}

function detectAllIncidents(markdownRoot: string): DetectedIncident[] {
  const corpus = scanCorpus(markdownRoot);
  return DETECTORS.flatMap((detector) => detector.detect(corpus)).sort(compareIncident);
}

function scanCorpus(markdownRoot: string) {
  const markdownFiles = [
    ...scanMarkdownDirectory(markdownRoot, 'note', 'notes'),
    ...scanMarkdownDirectory(markdownRoot, 'source', 'sources'),
    ...scanMarkdownDirectory(markdownRoot, 'community', 'communities'),
    ...scanMarkdownDirectory(markdownRoot, 'principle', 'principles'),
  ];

  const entityGraphPath = join(markdownRoot, '.entity-graph.json');
  const entityGraph = existsSync(entityGraphPath)
    ? createCorpusEntityGraphScan({
        path: entityGraphPath,
        content: readFileSync(entityGraphPath, 'utf-8'),
      })
    : null;

  return createCorpusScanView({
    markdownFiles,
    entityGraph,
  });
}

function scanMarkdownDirectory(
  markdownRoot: string,
  kind: CorpusMarkdownKind,
  relativeDir: string,
) {
  const dirPath = join(markdownRoot, relativeDir);
  return sortedMarkdownEntries(dirPath).map((entry) =>
    createCorpusMarkdownFileScan({
      kind,
      path: join(dirPath, entry),
      content: readFileSync(join(dirPath, entry), 'utf-8'),
    }),
  );
}

function captureTextFiles(root: string): Record<string, string> {
  const files: Record<string, string> = {};

  function walk(dirPath: string, prefix = ''): void {
    if (!existsSync(dirPath)) {
      return;
    }

    for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
      const relativePath = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      const absolutePath = join(dirPath, entry.name);

      if (entry.isDirectory()) {
        walk(absolutePath, relativePath);
        continue;
      }

      files[relativePath] = readFileSync(absolutePath, 'utf-8');
    }
  }

  walk(root);
  return Object.fromEntries(Object.entries(files).sort(([left], [right]) => left.localeCompare(right)));
}

function compareIncident(left: DetectedIncident, right: DetectedIncident): number {
  return `${left.canonical}\t${left.entryId}`.localeCompare(`${right.canonical}\t${right.entryId}`);
}

function expectDetectedIncidents(
  actual: readonly DetectedIncident[],
  expected: readonly ExpectedDetectedIncident[],
): void {
  const sortedExpected = [...expected].sort((left, right) =>
    `${left.canonical}\t${left.entryId}`.localeCompare(`${right.canonical}\t${right.entryId}`),
  );

  expect(actual).toHaveLength(sortedExpected.length);

  for (const [index, expectedIncident] of sortedExpected.entries()) {
    const actualIncident = actual[index];
    expect(actualIncident).toMatchObject({
      locus: expectedIncident.locus,
      canonical: expectedIncident.canonical,
      entryId: expectedIncident.entryId,
    });
    expectedIncident.assertSignals(actualIncident?.signals ?? {});
  }
}
