// Process-incarnation opacity invariant — a process's identity is an opaque token compared only by
// equality, and nothing may rebuild it from a clock or name it as one.
//
// Part of the rule lives in the type: `ProcessIncarnation` is a branded string, so subtraction and every
// other arithmetic operator stop at the compiler and "within N seconds" is not expressible. The brand does
// not stop `<` or `+` — TypeScript allows both on any string — and it cannot stop a module from deriving a
// fresh absolute timestamp and calling it an identity. Those are what this test owns.
//
// It is worth an invariant rather than a comment because prose demonstrably failed here. The previous
// primitive spread to a dozen comparison sites carried by a comment that named an unsound one as
// "Canonical pattern: src/infra/backend-discovery.ts:127,162". A comment can be wrong in the direction of
// the bug; a scan cannot.
//
// What the old shape cost, for anyone tempted to reintroduce it: btime is not a constant. The kernel
// recomputes it on every read as `realtime_now - boottime_now`, and where those clocks advance at different
// rates it climbs — measured at 3 seconds per 23 seconds of wall time on a WSL2 host. A value that adds it
// is therefore an identity plus a noise sample, and two processes comparing it disagree by roughly the age
// gap between their reads. That made a live coordinator look like a different process (an installed upgrade
// could not take over, and died on every session start) and made a live provider group look like no process
// at all (a disappearance receipt was minted for it).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { listProductionSourceFiles } from '#tests/helpers/ts-import-scanner.js';

const SRC_ROOT = join(process.cwd(), 'src');

/**
 * The boot clock's own file. `/proc/<pid>/stat` — the per-process file the incarnation probe legitimately
 * reads — never produces this text, because a template's quoted fragments are `/proc/` and `/stat` with the
 * pid interpolated between them. So this needs no owner exemption: not even the probe may name it.
 */
const BOOT_CLOCK_FILE = '/proc/stat';

/** The one module that may still spell the retired field, and the one declaration inside it that may. */
const LEGACY_FIELD_READER = 'provider-proxy/handoff-capsule.ts';
const LEGACY_SCHEMA_NAME = 'handoffCapsuleV2Schema';

/** The source span of the shipped V2 schema, or null when that declaration is gone — in which case nothing in
 *  the file is exempt, which is the correct answer. */
function legacySchemaSpan(source: ts.SourceFile): Readonly<{ start: number; end: number }> | null {
  let span: Readonly<{ start: number; end: number }> | null = null;
  walk(source, (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === LEGACY_SCHEMA_NAME) {
      span = { start: node.getStart(source), end: node.getEnd() };
    }
  });
  return span;
}

/** A name that promises a point in time. An incarnation is a token; the two must never meet. */
const TIME_FLAVOURED_NAME = /startedat|starttime|recordedstart|seconds|timestamp|epoch/i;

/** The probes that hand back an incarnation. A value taken from one is an identity whatever it is called. */
const INCARNATION_PROBE = /^(probe|read|canProbe)ProcessIncarnation$/;

/**
 * Readings of *now*, which is the one thing an identity may never contain.
 *
 * `Date.parse` is deliberately absent: the Darwin probe parses a start time the OS reported for the target
 * process, which is a coordinate belonging to that process. `Date.now()` belongs to the moment of the probe,
 * so a token built from it changes every time it is read — the previous primitive's exact defect, where two
 * processes disagreed by the age gap between their reads. That is the difference this rule turns on, and it
 * is why the rule names sources rather than the `Date` object.
 */
const CLOCK_SOURCE = /^(now|hrtime|uptime|getTime|valueOf)$/;
const CLOCK_OWNER = /^(Date|performance|process)$/;

type Offender = Readonly<{ file: string; detail: string }>;

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(file, readFileSync(file, 'utf-8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

/**
 * Literals, via the parser, rather than a text scan of the file. A raw scan reads the explanation in
 * `infra/node-process.ts`'s own doc comment as a violation, and the shared `codeTextOnly` helper is the
 * opposite tool — it *blanks* literals so identifier scans do not trip on quoted names, which would hide
 * exactly the path this rule is about.
 */
function literalTexts(source: ts.SourceFile): string[] {
  const texts: string[] = [];
  walk(source, (node) => {
    if (
      ts.isStringLiteralLike(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddleOrTemplateTail(node) ||
      // Regular expressions carry the boot clock's field name in the shape the removed code actually used:
      // `/^btime\s+(\d+)\s*$/m`. Inside a regex `btime` is not an identifier, so an identifier scan alone
      // reads the exact historical implementation as clean.
      ts.isRegularExpressionLiteral(node)
    ) {
      // Source text, not the cooked value. A tagged template's cooked text is absent when the template holds
      // an escape that is invalid in a string — `\s`, `\d` — which is precisely what a regex source contains,
      // so `String.raw\`^btime\s+(\d+)\`` reads as empty and slips through on `.text`.
      texts.push(node.getText(source));
    }
  });
  return texts;
}

function annotatedAsIncarnation(node: ts.Node): boolean {
  const declared = node as { type?: ts.TypeNode };
  return declared.type !== undefined && /\bProcessIncarnation\b/.test(declared.type.getText(node.getSourceFile()));
}

function initializedFromProbe(node: ts.VariableDeclaration): boolean {
  const call = node.initializer;
  if (call === undefined || !ts.isCallExpression(call)) return false;
  const callee = ts.isPropertyAccessExpression(call.expression) ? call.expression.name : call.expression;
  return ts.isIdentifier(callee) && INCARNATION_PROBE.test(callee.text);
}

describe('process incarnation opacity', () => {
  it('rebuilds no identity from the boot clock', () => {
    const offenders: Offender[] = [];
    for (const file of listProductionSourceFiles(SRC_ROOT)) {
      const source = parse(file);
      const relative = file.slice(SRC_ROOT.length + 1);
      for (const text of literalTexts(source)) {
        if (text.includes(BOOT_CLOCK_FILE)) offenders.push({ file: relative, detail: `reads ${BOOT_CLOCK_FILE}` });
        if (/\bbtime\b/.test(text)) offenders.push({ file: relative, detail: 'matches btime' });
      }
      walk(source, (node) => {
        if (ts.isIdentifier(node) && node.text === 'btime') {
          offenders.push({ file: relative, detail: 'names btime' });
        }
      });
    }

    expect(
      offenders,
      'a process identity may not be rebuilt from a boot clock; compare the opaque token instead',
    ).toEqual([]);
  });

  it('never names an incarnation as a time', () => {
    const offenders: Offender[] = [];
    for (const file of listProductionSourceFiles(SRC_ROOT)) {
      const source = parse(file);
      const relative = file.slice(SRC_ROOT.length + 1);
      walk(source, (node) => {
        const named =
          ts.isVariableDeclaration(node) ||
          ts.isPropertySignature(node) ||
          ts.isPropertyDeclaration(node) ||
          ts.isPropertyAssignment(node) ||
          ts.isParameter(node) ||
          ts.isMethodSignature(node) ||
          ts.isFunctionDeclaration(node);
        if (!named || node.name === undefined || !ts.isIdentifier(node.name)) return;
        if (!TIME_FLAVOURED_NAME.test(node.name.text)) return;

        const carriesIncarnation =
          annotatedAsIncarnation(node) || (ts.isVariableDeclaration(node) && initializedFromProbe(node));
        if (carriesIncarnation) {
          offenders.push({ file: relative, detail: `'${node.name.text}' holds an incarnation` });
        }
      });
    }

    expect(
      offenders,
      'the value is a token, not a timestamp — a name that reads as a time is how it was published into wire payloads and compared across processes',
    ).toEqual([]);
  });

  // The name itself, independent of what any declaration is annotated as. The rule above needs a type
  // annotation or a probe call to recognise an incarnation, so a value laundered through an unannotated
  // local — `const observed = identity.incarnation` — reaches a `processStartedAtSeconds:` property
  // invisibly. Banning the spelling closes that without pretending an AST scan can do data flow.
  it('does not reintroduce the retired field name', () => {
    const offenders: Offender[] = [];
    for (const file of listProductionSourceFiles(SRC_ROOT)) {
      const source = parse(file);
      const relative = file.slice(SRC_ROOT.length + 1);
      // The exemption is a *span*, not a file. Only the shipped V2 schema may spell these, and a
      // reintroduction elsewhere in the same file would use the very same names, so a filename allowlist
      // cannot tell the two apart — one was added to production code here and all three rules stayed green.
      const exempt = file.endsWith(LEGACY_FIELD_READER) ? legacySchemaSpan(source) : null;
      walk(source, (node) => {
        if (!ts.isIdentifier(node) && !ts.isStringLiteralLike(node)) return;
        if (!/ProcessStartedAtSeconds$/i.test(node.text)) return;
        const start = node.getStart(source);
        if (exempt !== null && start >= exempt.start && start < exempt.end) return;
        offenders.push({ file: relative, detail: `names '${node.text}'` });
      });
    }

    expect(
      offenders,
      `only ${LEGACY_SCHEMA_NAME} may name the retired field, and only to keep reading capsules v0.10.6-v0.10.8 wrote`,
    ).toEqual([]);
  });

  // The two rules above look for the *old* shape — the boot clock's file, and the retired field's name. Both
  // stay green on a token minted from a fresh clock reading under the new vocabulary:
  //
  //     return `linux:${bootId}:${Date.now()}` as ProcessIncarnation;
  //
  // That is the identical defect wearing the identical names, and it is the mutation this rule exists for. A
  // mint is recognisable without data flow because there is exactly one way to make one: an assertion to
  // `ProcessIncarnation`. Whatever is inside that assertion is the identity, and nothing that reads the
  // current time may be.
  it('mints no identity from a reading of now', () => {
    const offenders: Offender[] = [];
    for (const file of listProductionSourceFiles(SRC_ROOT)) {
      const source = parse(file);
      const relative = file.slice(SRC_ROOT.length + 1);
      walk(source, (node) => {
        if (!ts.isAsExpression(node) || !/\bProcessIncarnation\b/.test(node.type.getText(source))) return;
        walk(node.expression, (inner) => {
          if (
            ts.isNewExpression(inner) &&
            ts.isIdentifier(inner.expression) &&
            CLOCK_OWNER.test(inner.expression.text)
          ) {
            offenders.push({ file: relative, detail: `mints from new ${inner.expression.text}()` });
            return;
          }
          if (!ts.isCallExpression(inner) || !ts.isPropertyAccessExpression(inner.expression)) return;
          const owner = inner.expression.expression;
          if (!CLOCK_SOURCE.test(inner.expression.name.text)) return;
          if (!ts.isIdentifier(owner) || !CLOCK_OWNER.test(owner.text)) return;
          offenders.push({ file: relative, detail: `mints from ${owner.text}.${inner.expression.name.text}()` });
        });
      });
    }

    expect(
      offenders,
      "an incarnation is the process's own coordinate, not the moment it was observed; a token that moves between reads is not an identity",
    ).toEqual([]);
  });
});
