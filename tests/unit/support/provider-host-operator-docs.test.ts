import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import type { Principal } from '#src/security/principal.js';
import { executeCatalogRequest } from '#src/transport/dispatch.js';
import { providerHostInspectRpcSpec } from '#src/transport/rpc/catalog.js';
import type { HttpHandlerPorts } from '#src/transport/server-ports.js';

const cliErrors = readFileSync(join(process.cwd(), 'docs', 'cli-errors.md'), 'utf8');
const configuration = readFileSync(join(process.cwd(), 'docs', 'configuration.md'), 'utf8');
const architecture = readFileSync(join(process.cwd(), 'docs', 'architecture.md'), 'utf8');

const operator: Principal = {
  subject: 'operator',
  transport: 'ipc',
  credential: { kind: 'boot-token', id: 'operator' },
  binding: { kind: 'unbound' },
};

function catalogEntry(code: string): string {
  const prefix = `| \`${code}\``;
  const entry = cliErrors.split('\n').find((line) => line.startsWith(prefix));
  if (entry === undefined) throw new Error(`Missing CLI error catalog entry for ${code}`);
  return entry;
}

function paragraphContaining(anchor: string): string {
  const line = cliErrors.split('\n').find((entry) => entry.includes(anchor));
  if (line === undefined) throw new Error(`Missing document paragraph containing ${anchor}`);
  return line;
}

// Matches this document's own pointer convention (conventions.md: "a symbol name and a path"): a backtick-quoted
// identifier immediately followed by a backtick-quoted `src/**.ts` path. Deliberately structural — it must not
// pin which symbols are cited, only that whatever is cited still exists, so a renamed or deleted symbol cannot
// go stale silently.
const SYMBOL_CITATION_PATTERN = /`([A-Za-z_][A-Za-z0-9_]*)`, `(src\/[^`]+\.ts)`/g;

function symbolCitations(markdown: string): readonly Readonly<{ symbol: string; path: string }>[] {
  return [...markdown.matchAll(SYMBOL_CITATION_PATTERN)].map(([, symbol, path]) => ({ symbol, path }));
}

describe('provider-host operator documentation', () => {
  it('documents actionable recovery for every administration refusal', () => {
    expect(catalogEntry('provider_host_inventory_unavailable')).toContain('retry the exact reference');
    expect(catalogEntry('provider_host_inventory_unavailable')).toContain(
      'If the error persists, run `coral-cli backend shutdown`, then retry the original command to start a fresh coordinator.',
    );
    expect(catalogEntry('provider_host_not_found')).toContain('coral-cli backend provider-host list');
    expect(catalogEntry('provider_host_ambiguous')).toContain('provider-host inspect <ref>');
    expect(catalogEntry('provider_host_ambiguous')).toContain('provider-host evict <ref>');
    expect(catalogEntry('provider_host_eviction_requires_exact_ref')).toContain('cannot use a work directory');
    expect(catalogEntry('provider_host_eviction_requires_exact_ref')).toContain('provider-host evict <ref>');
    expect(catalogEntry('provider_host_identity_integrity')).toContain('Do **not** evict');
    expect(catalogEntry('provider_host_identity_integrity')).toContain('coral-cli backend status');
    expect(catalogEntry('provider_host_shutdown_held')).toContain('observation');
    expect(catalogEntry('provider_host_shutdown_held')).toContain('successorOwner');
    expect(catalogEntry('provider_host_shutdown_held')).toContain('operatorExit');
    expect(catalogEntry('provider_host_shutdown_held')).toContain('provider-host evict <ref>');
    expect(catalogEntry('provider_host_operator_abandoned')).toContain('processAbsenceProven: false');
    expect(catalogEntry('provider_host_operator_abandoned')).toContain('Inspect the recorded process');
    expect(catalogEntry('provider_host_operator_abandoned')).toContain("owner process's lifetime");
    expect(catalogEntry('provider_host_operator_abandoned')).toContain('exact reference remains retryable');
    expect(catalogEntry('provider_host_stale')).toContain('coral-cli backend provider-host list');
  });

  it('documents the failed-job recovery sequence', () => {
    const entry = catalogEntry('provider_host_unserviceable');
    expect(entry).toContain("initial failing job's `coral-cli wait` output preserves the provider's raw failure cause");
    expect(entry).toContain('no second placement attempt is required');
    expect(entry).toContain('`ph1.…`');
    expect(entry.indexOf('provider-host inspect <ref>')).toBeLessThan(entry.indexOf('provider-host evict <ref>'));
  });

  it('documents inventory unavailability and a torn-down owner as IPC retry-later exit 75', () => {
    expect(cliErrors).toContain(
      '`provider_host_inventory_unavailable` and `provider_host_owner_torn_down` (both matched by code name because the IPC path carries no HTTP status)',
    );
    expect(cliErrors).toContain(
      'provider-host errors other than `provider_host_inventory_unavailable` and `provider_host_owner_torn_down`',
    );
  });

  it('names the released owners at their own address and quotes the list line an operator reads verbatim', () => {
    expect(cliErrors).toContain('`coordinator.provider_host.list.v2` always answers `tornDownOwnerIds`');
    expect(cliErrors).toContain('keeps its exact `{ hosts }` shape for a shipped CLI');
    expect(cliErrors).toContain(
      'provider_host_owner_torn_down: administration control released for <ids>; their hosts are not listed.',
    );
  });

  it('names every exit the release can be ended through, including the one a work directory is left with', async () => {
    // see providerHostAdministrationCopy in src/transport/dispatch.ts
    // This check must drive that code directly rather than pin a copy of its output, or drift between
    // the two goes undetected again.
    const inspect = vi.fn(async () => {
      throw Object.assign(new Error('provider_host_owner_torn_down'), {
        code: 'provider_host_owner_torn_down',
        ownerIds: ['provider-proxy:set-a'],
        matches: [],
        workDir: process.cwd(),
      });
    });
    const ports = { providerHosts: { list: vi.fn(), inspect, evict: vi.fn() } } as unknown as HttpHandlerPorts;
    const result = await executeCatalogRequest(
      providerHostInspectRpcSpec,
      { workDir: '.', projectRoot: process.cwd() },
      ports,
      operator,
    );
    if (result.kind !== 'unary') throw new Error('expected a unary provider-host refusal');
    const body = result.body as { remediation: string };
    const paragraph = paragraphContaining('are also served while the coordinator drains');
    const entry = catalogEntry('provider_host_owner_torn_down');

    // A string this build's own remediation does not name must stay absent from the document
    // describing that same remediation, so the document cannot re-offer what the code no longer produces.
    for (const marker of [
      'provider-proxy-set contain',
      'provider-proxy-set abandon',
      'successor',
      're-establish',
      'shutdown-recovery abandon',
    ]) {
      expect(body.remediation).not.toContain(marker);
      expect(paragraph).not.toContain(marker);
      expect(entry).not.toContain(marker);
    }
    expect(cliErrors).not.toContain('coral-cli backend shutdown-recovery abandon');

    // Every exit the running remediation actually names must still be named in the document.
    expect(body.remediation).toContain('coral-cli backend status');
    expect(entry).toContain('coral-cli backend status');
    expect(paragraph).toContain('coral-cli backend status');
    expect(body.remediation).toContain('drain ends by itself');
    expect(paragraph).toContain('ends by itself when its budget is exhausted');
    expect(body.remediation).toContain('coral-cli backend provider-host list');
    expect(paragraph).toContain(
      'for a work directory the rendered remediation therefore starts with `coral-cli backend provider-host list`',
    );
  });

  it('documents both inventory-unavailable and identity-integrity causes', () => {
    expect(catalogEntry('provider_host_inventory_unavailable')).toContain(
      "selected owner's exact inspect/evict call failed after owner selection",
    );
    expect(catalogEntry('provider_host_identity_integrity')).toContain('duplicate owner IDs before selecting a host');
    expect(catalogEntry('provider_host_identity_integrity')).toContain('exact host reference collided');
  });

  it('documents conditional containment and retryability for failed close or reclamation', () => {
    for (const document of [configuration, cliErrors]) {
      expect(document).toContain('reclamation-failed');
      expect(document).toContain('did not complete a provider-host close or recorded-containment reclamation');
      expect(document).toContain('pid');
      expect(document).toContain('processGroupId');
      expect(document).toContain('reclamationAttempts');
      expect(document).toContain('reclamationFailure');
      expect(document).toContain('reclamationRetryable');
      expect(document).toContain('only `pid` is present');
      expect(document).toContain('recorded containment carries both values');
      expect(document).toContain('pre-containment');
      expect(document).toContain('eviction cannot');
      expect(document).toContain('escalate rather than discarding that evidence by restarting');
    }
    expect(catalogEntry('provider_host_not_found')).toContain('reclamation-failed');
  });

  it('places authorization at the RPC boundary, not in the administration service', () => {
    expect(architecture).toContain(
      'The RPC boundary performs capability and resource authorization before calling `ProviderHostAdministrationService`; the service itself receives no principal.',
    );
  });

  it('resolves every symbol citation in cli-errors.md against the current source tree', () => {
    const citations = symbolCitations(cliErrors);
    // A citation this test never sees is a guard that would pass on an empty document; assert the convention is
    // actually exercised so a future rewording that drops the pointer syntax entirely does not go unnoticed.
    expect(citations.length).toBeGreaterThan(0);
    for (const { symbol, path } of citations) {
      let source: string;
      try {
        source = readFileSync(join(process.cwd(), path), 'utf8');
      } catch {
        throw new Error(`cli-errors.md cites \`${symbol}\` in ${path}, but ${path} does not exist`);
      }
      const stillPresent = new RegExp(`\\b${symbol}\\b`).test(source);
      expect(
        stillPresent,
        `cli-errors.md cites \`${symbol}\` in ${path}, but that symbol no longer appears there`,
      ).toBe(true);
    }
  });
});
