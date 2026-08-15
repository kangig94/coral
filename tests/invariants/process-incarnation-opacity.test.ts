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

/** The one module that may still spell the retired field: its V2 schema is how shipped capsules stay readable. */
const LEGACY_FIELD_READER = 'provider-proxy/handoff-capsule.ts';

/** A name that promises a point in time. An incarnation is a token; the two must never meet. */
const TIME_FLAVOURED_NAME = /startedat|starttime|recordedstart|seconds|timestamp|epoch/i;

/** The probes that hand back an incarnation. A value taken from one is an identity whatever it is called. */
const INCARNATION_PROBE = /^(probe|read|canProbe)ProcessIncarnation$/;

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
    const offenders = listProductionSourceFiles(SRC_ROOT)
      .filter((file) => !file.endsWith(LEGACY_FIELD_READER))
      .filter((file) => {
        let found = false;
        walk(parse(file), (node) => {
          if ((ts.isIdentifier(node) || ts.isStringLiteralLike(node)) && /ProcessStartedAtSeconds$/i.test(node.text)) {
            found = true;
          }
        });
        return found;
      })
      .map((file) => file.slice(SRC_ROOT.length + 1));

    expect(
      offenders,
      `only ${LEGACY_FIELD_READER} may name the retired field, and only to keep reading capsules v0.10.6-v0.10.8 wrote`,
    ).toEqual([]);
  });
});
