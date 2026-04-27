import type {
  KbDeleteResponse,
  KbMemoResponse,
  KbPromoteResponse,
  KbSourceDeleteResponse,
  KbSourceImportResponse,
  KbUpdateResponse,
} from '../../transport/http/client.js';
import type {
  KbDiagnoseResult,
  KbMemoDeleteResult,
  KbMemoListResult,
  KbMemoPurgeResult,
  KbPrincipleVerboseRow,
  KbPrinciplesResult,
  KbReadResult,
  KbSearchResponse,
  KbSourceListResult,
  ReindexResult,
} from '../../kb/entry-types.js';
import { formatTable, joinLines } from '../../infra/text.js';

type KbReadDisplayResult = KbReadResult & { age?: string };

function normalizeKbWarning(warning: string | undefined, cliPrefix = 'coral-cli'): string | undefined {
  if (warning === undefined || warning.length === 0) {
    return undefined;
  }

  return warning
    .replace(
      /\bkb_search_degraded_until_coordinator_rebuild\b/g,
      'Search index is unavailable; start the Coral backend to rebuild it.',
    )
    .replace(/\bkb_reindex\b/g, () => `${cliPrefix} kb reindex`);
}

function normalizeKbWarnings(
  warnings: string[] | undefined,
  cliPrefix = 'coral-cli',
): string[] | undefined {
  if (warnings === undefined || warnings.length === 0) {
    return undefined;
  }

  return warnings.map((warning) => normalizeKbWarning(warning, cliPrefix) ?? warning);
}

function isVerbosePrincipleRows(
  principles: KbPrinciplesResult['principles'],
): principles is KbPrincipleVerboseRow[] {
  return principles.length > 0 && typeof principles[0] !== 'string';
}

function toKbReadDisplayResult(data: KbReadResult): KbReadDisplayResult {
  if (typeof data.updatedAt !== 'string') {
    return data;
  }

  const ms = Date.now() - Date.parse(data.updatedAt);
  const days = Math.floor(ms / 86_400_000);
  let age: string;

  if (days === 0) {
    age = 'today';
  } else if (days === 1) {
    age = '1 day ago';
  } else {
    age = `${days} days ago`;
  }

  return {
    ...data,
    age,
  };
}

/** KB search is consumed by LLM agents, not humans — always return JSON. Do not add text-mode formatting. */
export function formatKbSearch(data: KbSearchResponse, cliPrefix = 'coral-cli'): string {
  const warning = normalizeKbWarning(data.warning, cliPrefix);
  const warnings = normalizeKbWarnings(data.warnings, cliPrefix);
  const results = data.results.map((result) => {
    return {
      note: result.note,
      kind: result.kind,
      title: result.title,
      matched: result.matchedBy,
      snippet: result.snippet ?? '-',
    };
  });

  const output: Record<string, unknown> = {
    results,
    mode: data.mode,
    count: results.length,
  };

  if (data.mode === 'hybrid') {
    output.indicator = '[hybrid]';
  } else if (data.mode === 'vector') {
    output.indicator = '[vector]';
  }

  if (warning !== undefined) {
    output.warning = warning;
  }
  if (warnings !== undefined) {
    output.warnings = warnings;
  }

  return JSON.stringify(output);
}

export function formatKbDiagnose(data: KbDiagnoseResult): string {
  if (data.incidents.length === 0) {
    return 'No incidents need manual repair';
  }

  return data.incidents
    .map((incident) =>
      joinLines([
        `entry_id: ${incident.entry_id}`,
        `locus: ${incident.locus ?? 'null'}`,
        `canonical_incident: ${incident.canonical_incident ?? 'null'}`,
        `repair_hint: ${incident.repair_hint ?? 'null'}`,
        'signals:',
        JSON.stringify(incident.signals ?? null, null, 2),
        `retry_count: ${incident.retry_count}`,
        `retry_not_before: ${incident.retry_not_before}`,
      ]),
    )
    .join('\n\n');
}

export function formatKbPrinciples(data: KbPrinciplesResult, cliPrefix = 'coral-cli'): string {
  const principles = data.principles;
  const warning = normalizeKbWarning(data.warning, cliPrefix);
  let principlesText: string;

  if (!isVerbosePrincipleRows(principles)) {
    principlesText = principles.length === 0 ? 'No principles' : principles.join('\n');
  } else {
    const rows = principles.map((value) => {
      const notes = value.notes.length === 0 ? '' : ` (${value.notes.join(', ')})`;
      return `${value.name}${notes}: ${value.statement}`;
    });

    principlesText = rows.length === 0 ? 'No principles' : rows.join('\n');
  }

  return joinLines([
    principlesText,
    `Total: ${data.total}`,
    warning === undefined ? undefined : `Warning: ${warning}`,
  ]);
}

export function formatKbRead(data: KbReadResult): string {
  return JSON.stringify(toKbReadDisplayResult(data));
}

export function formatKbMemo(data: KbMemoResponse): string {
  return `Memo: ${data.filename}`;
}

export function formatKbMemoList(data: KbMemoListResult): string {
  const rows = data.memos.map((memo) => [memo.filename, memo.summary, memo.createdAt]);

  if (rows.length === 0) {
    return 'No memos';
  }

  return formatTable(['FILENAME', 'SUMMARY', 'CREATED AT'], rows);
}

export function formatKbMemoDelete(data: KbMemoDeleteResult): string {
  return joinLines([data.deleted.length === 0 ? 'No memos deleted' : data.deleted.join('\n'), `Count: ${data.count}`]);
}

export function formatKbMemoPurge(data: KbMemoPurgeResult): string {
  return `Purged: ${data.deleted} memos`;
}

export function formatKbPromote(data: KbPromoteResponse): string {
  return `Created: ${data.path}`;
}

export function formatKbUpdate(data: KbUpdateResponse): string {
  return `Updated: ${data.path}`;
}

export function formatKbDelete(data: KbDeleteResponse): string {
  return `Deleted: ${data.deleted}`;
}

export function formatKbSourceImport(data: KbSourceImportResponse): string {
  switch (data.status) {
    case 'running':
    case 'queued':
      return `Import job ${data.job} ${data.status} (ready=${data.readiness})`;
    case 'completed':
      return `Imported: ${data.path}`;
  }
}

export function formatKbSourceList(data: KbSourceListResult): string {
  const rows = data.sources.map((source) => [source.slug, source.title, source.type, source.importedAt]);

  if (rows.length === 0) {
    return 'No sources';
  }

  return formatTable(['SLUG', 'TITLE', 'TYPE', 'IMPORTED AT'], rows);
}

export function formatKbSourceDelete(data: KbSourceDeleteResponse): string {
  return `Deleted: ${data.deleted}`;
}

export function formatKbReindex(data: ReindexResult, cliPrefix = 'coral-cli'): string {
  const warning = normalizeKbWarning(data.warning, cliPrefix);

  return joinLines([
    `Reindexed: ${data.notes} notes, ${data.communities} communities, ${data.principles} principles, ${data.tags} tags (${data.duration_ms}ms, ${data.mode})`,
    warning === undefined ? undefined : `Warning: ${warning}`,
  ]);
}
