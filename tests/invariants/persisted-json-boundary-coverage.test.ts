import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { persistedCodecNamesFromDdl } from '#src/store/format-fingerprint.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SCHEMA = readFileSync(join(ROOT, 'src/store/schema.sql'), 'utf-8');

const BOUNDARIES = [
  {
    name: 'store.events.body',
    table: 'events',
    column: 'body',
    evidence: [
      ['src/store/append.ts', 'encodeEventBody'],
      ['src/store/body-codec.ts', 'decodeEventBody'],
    ],
  },
  {
    name: 'store.events.refs',
    table: 'events',
    column: 'refs',
    evidence: [
      ['src/store/append.ts', 'JSON.stringify(input.refs)'],
      ['src/store/envelope.ts', 'journalEventRefsSchema.parse'],
    ],
  },
  {
    name: 'store.projection_jobs.terminal',
    table: 'projection_jobs',
    column: 'terminal',
    evidence: [
      ['src/jobs/projection-row.ts', "jobTerminalSchema.parse(parseJson(row.terminal, 'terminal', row.job_id))"],
      ['src/jobs/projections.ts', 'JSON.stringify(next.terminal)'],
    ],
  },
  {
    name: 'store.projection_jobs.diagnostics',
    table: 'projection_jobs',
    column: 'diagnostics',
    evidence: [
      [
        'src/jobs/projection-row.ts',
        "jobDiagnosticsSchema.parse(parseJson(row.diagnostics, 'diagnostics', row.job_id))",
      ],
      ['src/jobs/projections.ts', 'JSON.stringify(next.diagnostics)'],
    ],
  },
  {
    name: 'store.projection_jobs.execution_owner',
    table: 'projection_jobs',
    column: 'execution_owner',
    evidence: [
      [
        'src/jobs/projection-row.ts',
        "executionOwnerSchema.parse(parseJson(row.execution_owner, 'execution_owner', row.job_id))",
      ],
      ['src/jobs/projections.ts', 'JSON.stringify(next.owner)'],
    ],
  },
  {
    name: 'store.projection_sessions.entry',
    table: 'projection_sessions',
    column: 'entry',
    evidence: [
      ['src/sessions/projections.ts', 'providerSessionSchema.safeParse(parsed)'],
      ['src/sessions/projections.ts', 'JSON.stringify(next.entry)'],
    ],
  },
  {
    name: 'store.projection_discuss.state',
    table: 'projection_discuss',
    column: 'state',
    evidence: [
      ['src/discuss/projections.ts', 'persistedDiscussSnapshotSchema.parse(JSON.parse(raw))'],
      ['src/discuss/projections.ts', 'JSON.stringify(next)'],
    ],
  },
  {
    name: 'store.projection_workflows.plan',
    table: 'projection_workflows',
    column: 'plan',
    evidence: [
      ['src/workflow/read-queries.ts', 'workflowPlanSchema.parse(JSON.parse(row.plan))'],
      ['src/workflow/events.ts', 'JSON.stringify(nextPlan)'],
    ],
  },
  {
    name: 'store.projection_workflows.provider_scope',
    table: 'projection_workflows',
    column: 'provider_scope',
    evidence: [
      ['src/workflow/read-queries.ts', 'providerScopeSchema.parse(JSON.parse(row.provider_scope))'],
      ['src/workflow/events.ts', 'JSON.stringify(providerScope)'],
    ],
  },
  {
    name: 'store.kb_curate_retry_queue.signals',
    table: 'kb_curate_retry_queue',
    column: 'signals_json',
    evidence: [
      ['src/kb/diagnose.ts', 'JSON.parse(entry.signalsJson)'],
      ['src/kb/corpus/rescan/auto-fix.ts', 'JSON.stringify(incident.signals)'],
    ],
  },
  {
    name: 'store.expansion_manifest_catalog.manifest',
    table: 'expansion_manifest_catalog',
    column: 'manifest_json',
    evidence: [
      ['src/expansion/manifest/catalog.ts', 'parseDeclarativeEngineManifest(JSON.parse(row.manifest_json)'],
      ['src/expansion/manifest/catalog.ts', 'JSON.stringify(declarative)'],
    ],
  },
] as const;

describe('persisted JSON boundary inventory', () => {
  it('independently ties every audited SQL JSON column to its codec and read/write evidence', () => {
    expect(persistedCodecNamesFromDdl(SCHEMA)).toEqual(BOUNDARIES.map(({ name }) => name).sort());

    for (const boundary of BOUNDARIES) {
      const tableStart = SCHEMA.indexOf(`CREATE TABLE IF NOT EXISTS ${boundary.table}`);
      expect(tableStart, `missing table ${boundary.table}`).toBeGreaterThanOrEqual(0);
      const tableEnd = SCHEMA.indexOf(');', tableStart);
      const tableDdl = SCHEMA.slice(tableStart, tableEnd);
      const columnLine = tableDdl.split('\n').find((line) => new RegExp(`^\\s*${boundary.column}\\s`, 'u').test(line));
      expect(columnLine, `missing ${boundary.table}.${boundary.column}`).toBeDefined();
      expect(columnLine).toContain(`JSON`);
      expect(columnLine).toContain(`@persisted-codec ${boundary.name}`);

      for (const [file, token] of boundary.evidence) {
        expect(readFileSync(join(ROOT, file), 'utf-8'), `${boundary.name} has no evidence in ${file}`).toContain(token);
      }
    }
  });
});
