import type {
  KbDeleteResponse,
  KbDiagnoseResult,
  KbMemoDeleteResult,
  KbMemoListResult,
  KbMemoPurgeResult,
  KbMemoResponse,
  KbPrincipleVerboseRow,
  KbPrinciplesResult,
  KbPromoteResponse,
  KbReadResult,
  KbReindexResponse,
  KbSearchResponse,
  KbSourceDeleteResponse,
  KbSourceImportResponse,
  KbSourceListResult,
  KbUpdateResponse,
  KbWakeUpResponse,
  KbWikiAdoptResponse,
  KbWikiCreateResponse,
  KbWikiDeleteResponse,
  KbWikiListResult,
  KbWikiMutationResponse,
} from '../../kb/entry-types.js';
import { formatTable, joinLines } from './text.js';

type KbReadDisplayResult = KbReadResult & { age?: string };
const MAX_RENDERED_EVIDENCE = 3;

/**
 * Hide on-disk paths from LLM-visible CLI output. A leaked path teaches the
 * LLM the storage layout, after which a raw `Read /home/.../kb/wiki/X.md`
 * bypasses kb tools — losing touch-journal signal, frontmatter parsing,
 * and invariant checks. CLI text identifies entries by
 * their canonical slug; JSON responses still carry the path field for
 * internal tests/scripts.
 */
function pathToSlug(pathOrFilename: string): string {
  const base = pathOrFilename.replace(/^.*[/\\]/u, '');
  return base.endsWith('.md') ? base.slice(0, -3) : base;
}

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

function normalizeKbWarnings(warnings: string[] | undefined, cliPrefix = 'coral-cli'): string[] | undefined {
  if (warnings === undefined || warnings.length === 0) {
    return undefined;
  }

  return warnings.map((warning) => normalizeKbWarning(warning, cliPrefix) ?? warning);
}

function formatCompactNumber(value: number): string {
  if (!Number.isFinite(value)) {
    return String(value);
  }

  return Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/0+$/u, '').replace(/\.$/u, '');
}

function formatRetrievalEvidence(result: KbSearchResponse['results'][number]): string[] {
  const rendered: string[] = [];
  const limit = Math.min(result.evidence.length, MAX_RENDERED_EVIDENCE);
  for (let index = 0; index < limit; index += 1) {
    const evidence = result.evidence[index];
    const weight = formatCompactNumber(evidence.weight);
    const contribution = formatCompactNumber(evidence.contribution);
    rendered.push(`[${evidence.roleId}:#${evidence.rank}(w=${weight},c=${contribution})]`);
  }
  return rendered;
}

function formatRetrievalDiagnosticWarnings(data: KbSearchResponse, cliPrefix: string): string[] {
  const warnings: string[] = [];
  for (const diagnostic of data.retrievalDiagnostics) {
    if (diagnostic.publicText !== undefined && diagnostic.publicText.length > 0) {
      warnings.push(`Warning: ${normalizeKbWarning(diagnostic.publicText, cliPrefix) ?? diagnostic.publicText}`);
      continue;
    }
    if (diagnostic.recoverable) {
      continue;
    }
    const recoveryHint =
      diagnostic.code === 'binding_missing'
        ? `Run 'coral-cli expansion list' to find an engine that fills the missing binding.`
        : `Check expansion status with 'coral-cli expansion list' or run 'coral-cli kb reindex'.`;
    warnings.push(
      `Warning: Search role '${diagnostic.roleId}' failed (${diagnostic.code}). Results may be incomplete. ${recoveryHint}`,
    );
  }
  return warnings;
}

function isVerbosePrincipleRows(principles: KbPrinciplesResult['principles']): principles is KbPrincipleVerboseRow[] {
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
  const diagnosticWarnings = formatRetrievalDiagnosticWarnings(data, cliPrefix);
  const results = data.results.map((result) => {
    return {
      note: result.note,
      kind: result.kind,
      title: result.title,
      matched: result.matchedBy,
      snippet: result.snippet ?? '-',
      evidence: formatRetrievalEvidence(result),
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
    output.warnings = [...warnings, ...diagnosticWarnings];
  } else if (diagnosticWarnings.length > 0) {
    output.warnings = diagnosticWarnings;
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
        incident.repair_hint === null ? undefined : `repair_hint: ${incident.repair_hint}`,
        incident.locus === null ? undefined : `locus: ${incident.locus}`,
        incident.canonical_incident === null ? undefined : `canonical_incident: ${incident.canonical_incident}`,
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

  return joinLines([principlesText, `Total: ${data.total}`, warning === undefined ? undefined : `Warning: ${warning}`]);
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
  return `Promoted note: ${pathToSlug(data.path)}`;
}

export function formatKbUpdate(data: KbUpdateResponse): string {
  return `Updated note: ${pathToSlug(data.path)}`;
}

export function formatKbDelete(data: KbDeleteResponse): string {
  return `Deleted note: ${pathToSlug(data.deleted)}`;
}

export function formatKbWikiCreate(data: KbWikiCreateResponse): string {
  return `Created wiki: ${data.slug}`;
}

export function formatKbWikiRewrite(data: KbWikiMutationResponse): string {
  return `Rewrote Understanding: ${pathToSlug(data.path)}`;
}

export function formatKbWikiLink(data: KbWikiMutationResponse): string {
  return `Linked Knowledge: ${pathToSlug(data.path)}`;
}

export function formatKbWikiUnlink(data: KbWikiMutationResponse): string {
  return `Unlinked Knowledge: ${pathToSlug(data.path)}`;
}

export function formatKbWikiCite(data: KbWikiMutationResponse): string {
  return `Appended evidence: ${pathToSlug(data.path)}`;
}

export function formatKbWikiAdopt(data: KbWikiAdoptResponse): string {
  return `Adopted note ${pathToSlug(data.path)} into wiki: ${data.wikiSlug}`;
}

export function formatKbWikiDelete(data: KbWikiDeleteResponse): string {
  return `Deleted wiki: ${pathToSlug(data.deleted)}`;
}

export function formatKbWikiList(data: KbWikiListResult): string {
  const rows = data.wikis.map((wiki) => [
    wiki.slug,
    wiki.title,
    wiki.updatedAt,
    wiki.tags.length === 0 ? '-' : wiki.tags.join(', '),
  ]);

  if (rows.length === 0) {
    return 'No wikis';
  }

  return formatTable(['SLUG', 'TITLE', 'UPDATED AT', 'TAGS'], rows);
}

export function formatKbWakeUp(data: KbWakeUpResponse): string {
  const entryCount = (data.content.match(/^## /gmu) ?? []).length;
  const tokenEstimate = Math.ceil(Buffer.byteLength(data.content, 'utf8') / 4);
  return `# KB wake-up packet (${entryCount} entries, ~${tokenEstimate} tokens)\n${data.content}`;
}

export function formatKbSourceImport(data: KbSourceImportResponse): string {
  switch (data.status) {
    case 'running':
    case 'queued':
      return `Import job ${data.job} ${data.status} (ready=${data.readiness})`;
    case 'completed':
      return `Imported source: ${data.slug}`;
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
  return `Deleted source: ${pathToSlug(data.deleted)}`;
}

export function formatKbReindex(data: KbReindexResponse, cliPrefix = 'coral-cli'): string {
  if ('status' in data) {
    return `Reindex job ${data.job} ${data.status}`;
  }

  const warning = normalizeKbWarning(data.warning, cliPrefix);

  return joinLines([
    `Reindexed: ${data.notes} notes, ${data.communities} communities, ${data.wikis} wikis, ${data.principles} principles, ${data.tags} tags (${data.duration_ms}ms, ${data.mode})`,
    warning === undefined ? undefined : `Warning: ${warning}`,
  ]);
}
