import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';

import { listProductionSourceFiles, toCanonicalSrcPath } from '#tests/helpers/ts-import-scanner.js';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const FIXTURE_PATH = resolve(REPO_ROOT, 'tests/invariants/fixtures/correlation-origination.ts.txt');
const PRODUCTION_FILES = listProductionSourceFiles(join(REPO_ROOT, 'src'));

/**
 * A correlation value names one party's claim to one operation across a process boundary. Each is minted by
 * exactly one authority and, everywhere else, only ever received. The branded types in
 * `provider-proxy/protocol.ts` say that to the compiler; this file bans the shape a brand cannot see — a
 * correlation field on a wire payload whose value is fresh randomness rather than something received.
 *
 * The defect it exists for: `role-main.ts`'s containment wiring once minted a fresh reservation instead of
 * forwarding the one the proxy had already reserved. Every field was present and every type was right, so no
 * schema could refuse it; the guardian's stored membership simply could never agree with what the coordinator
 * later presented, and every activation failed `identity_mismatch`.
 *
 * What it checks, precisely: a correlation-named property whose **own initializer expression** contains
 * randomness. It does not follow dataflow, so `const r = ids.uuid(); call({ reservation: r })` and
 * `{ reservation: mintReservation() }` both pass — and the second is how this codebase legitimately spells its
 * own mints (`acquisition-steps.ts`, `set-authority.ts`), so the rule cannot be widened to catch it without
 * flagging the authorities it exists to protect. The brands are what cover the indirect spelling; this rule
 * covers the direct one, which is the shape the real defect actually had.
 *
 * It matches nothing in `src/` today, which is the point — and also the hazard. A rule that names nothing is
 * indistinguishable from a rule that is broken, so it is exercised against fixtures on every run rather than
 * trusted because the tree happens to be clean.
 */
const CORRELATION_FIELDS = new Set([
  'reservation',
  'jointContainmentReceipt',
  'jointActivationReceipt',
  'redemptionReceipt',
  'guardianRedemptionReceipt',
  'reaperRotationReceipt',
  'grantId',
  'secret',
  'secretSha256',
  'bootstrapNonce',
  'guardianReaperAuthSecret',
  'proxyGuardianAuthSecret',
  'pairingSecret',
  'disappearanceReceipt',
  'heartbeatChallenge',
  'nextHeartbeatChallenge',
  'challenge',
  'nextChallenge',
]);

const RANDOMNESS = /\bids\.uuid\s*\(|\brandomUUID\b|\brandomBytes\s*\(|\bMath\.random\s*\(/u;

function propertyName(node: ts.ObjectLiteralElementLike): string | null {
  if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name)) return node.name.text;
  if (ts.isShorthandPropertyAssignment(node)) return node.name.text;
  return null;
}

/**
 * Correlation-named properties whose initializer produces fresh randomness. Walking the AST rather than the
 * text is what makes a comment or a quoted mention a non-event: comments are not nodes, and a string
 * literal's contents are its own rather than an expression.
 */
function fabricationSites(name: string, source: string): string[] {
  const parsed = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) {
      for (const property of node.properties) {
        const field = propertyName(property);
        if (field === null || !CORRELATION_FIELDS.has(field)) continue;
        const initializer = ts.isPropertyAssignment(property) ? property.initializer : property;
        if (RANDOMNESS.test(initializer.getText())) found.push(`${name}: ${field}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return found;
}

type Fixture = Readonly<{ name: string; source: string; shouldFlag: boolean }>;

function readFixtures(): Fixture[] {
  return readFileSync(FIXTURE_PATH, 'utf8')
    .split(/^=== /mu)
    .slice(1)
    .map((section) => {
      const newline = section.indexOf('\n');
      const name = section.slice(0, newline).trim();
      return { name, source: section.slice(newline + 1).trim(), shouldFlag: !name.startsWith('clean:') };
    });
}

describe('a correlation value is originated once and received everywhere else', () => {
  it('no production module puts fresh randomness in a correlation field', () => {
    const violations = PRODUCTION_FILES.flatMap((filePath) =>
      fabricationSites(toCanonicalSrcPath(REPO_ROOT, filePath), readFileSync(filePath, 'utf8')),
    );

    expect(violations).toEqual([]);
  });

  it.each(readFixtures().map((fixture) => [fixture.name, fixture] as const))(
    'fixture — %s',
    (_name, fixture: Fixture) => {
      const flagged = fabricationSites('fixture.ts', fixture.source);
      // Every fixture is a live proof that the rule above still discriminates. Without them, deleting the
      // rule's body would leave every run green, because `src/` legitimately contains none of these shapes.
      expect(flagged.length > 0).toBe(fixture.shouldFlag);
    },
  );
});
