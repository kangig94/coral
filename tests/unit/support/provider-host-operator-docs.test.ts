import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const cliErrors = readFileSync(join(process.cwd(), 'docs', 'cli-errors.md'), 'utf8');
const architecture = readFileSync(join(process.cwd(), 'docs', 'architecture.md'), 'utf8');

function catalogEntry(code: string): string {
  const prefix = `| \`${code}\``;
  const entry = cliErrors.split('\n').find((line) => line.startsWith(prefix));
  if (entry === undefined) throw new Error(`Missing CLI error catalog entry for ${code}`);
  return entry;
}

describe('provider-host operator documentation', () => {
  it('documents actionable recovery for every administration refusal', () => {
    expect(catalogEntry('provider_host_inventory_unavailable')).toContain(
      'Retry the original command; if it persists, run `coral-cli backend shutdown`, then retry the original command to start a fresh coordinator.',
    );
    expect(catalogEntry('provider_host_not_found')).toContain('coral-cli backend provider-host list');
    expect(catalogEntry('provider_host_ambiguous')).toContain('provider-host inspect <ref>');
    expect(catalogEntry('provider_host_ambiguous')).toContain('provider-host evict <ref>');
    expect(catalogEntry('provider_host_identity_integrity')).toContain('Do **not** evict');
    expect(catalogEntry('provider_host_stale')).toContain('coral-cli backend provider-host list');
  });

  it('documents the failed-job recovery sequence', () => {
    const entry = catalogEntry('provider_host_unserviceable');
    expect(entry).toContain("initial failing job's `coral-cli wait` output preserves the provider's raw failure cause");
    expect(entry).toContain('no second placement attempt is required');
    expect(entry).toContain('`ph1.…`');
    expect(entry.indexOf('provider-host inspect <ref>')).toBeLessThan(entry.indexOf('provider-host evict <ref>'));
  });

  it('documents inventory unavailability as IPC retry-later exit 75', () => {
    expect(cliErrors).toContain(
      '`provider_host_inventory_unavailable` (matched by code name because the IPC path carries no HTTP status)',
    );
  });

  it('documents both inventory-unavailable and identity-integrity causes', () => {
    expect(catalogEntry('provider_host_inventory_unavailable')).toContain(
      "selected owner's exact inspect/evict call failed after inventory capture",
    );
    expect(catalogEntry('provider_host_identity_integrity')).toContain('duplicate owner IDs before selecting a host');
    expect(catalogEntry('provider_host_identity_integrity')).toContain('exact host reference collided');
  });

  it('places authorization at the RPC boundary, not in the administration service', () => {
    expect(architecture).toContain(
      'The RPC boundary performs capability and resource authorization before calling `ProviderHostAdministrationService`; the service itself receives no principal.',
    );
  });
});
