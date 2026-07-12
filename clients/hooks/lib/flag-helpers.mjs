// Flag/value semantic helpers for shell tokens produced by shell-parser.mjs.
// Token shape is defined there; these helpers answer "is this token exactly
// --foo?", "does this token carry --foo=<value>?", and "is the captured
// value quoted, unquoted, or a mix?" — without any CLI-specific knowledge.

export function isExactToken(token, value) {
  return token.segments.length === 1 && token.segments[0].kind === 'unquoted' && token.value === value;
}

// If `token` begins with `prefix` as an unquoted run, returns the segments
// that represent the value portion (post-prefix). Returns null when the
// token does not begin with prefix, or when the prefix is the only content.
export function getInlineValueSegments(token, prefix) {
  const firstSegment = token.segments[0];
  if (firstSegment?.kind !== 'unquoted') return null;
  if (!firstSegment.value.startsWith(prefix)) return null;
  if (firstSegment.value === prefix && token.segments.length === 1) return null;

  const valueSegments = [];
  const remainder = firstSegment.value.slice(prefix.length);
  if (remainder.length > 0) {
    valueSegments.push({
      kind: 'unquoted',
      raw: firstSegment.raw.slice(prefix.length),
      value: remainder,
    });
  }

  valueSegments.push(...token.segments.slice(1));
  return valueSegments;
}

// Classifies a segment list into one of three shapes:
//   { kind: 'unquoted', value }  — single unquoted run, or multiple adjacent unquoted runs
//   { kind: 'quoted',   value }  — exactly one quoted segment
//   { kind: 'complex' }          — mix of quoted and unquoted (value not easily recoverable)
export function analyzeValueSegments(segments) {
  if (segments.length === 0) {
    return { kind: 'unquoted', value: '' };
  }

  if (segments.length === 1) {
    const [segment] = segments;
    return segment.kind === 'unquoted'
      ? { kind: 'unquoted', value: segment.value }
      : { kind: 'quoted', value: segment.value };
  }

  return segments.some((segment) => segment.kind !== 'unquoted')
    ? { kind: 'complex' }
    : { kind: 'unquoted', value: segments.map((segment) => segment.value).join('') };
}

// Treats `tokens[index + 1]` as the value for a flag that appeared as its own
// token (e.g., `--input prompt.txt`). Returns an analyzeValueSegments result
// augmented with `nextIndex` (pointing at the consumed value token) and a
// `replacement` slot describing the value token's range.
function analyzeSeparateValue(tokens, index) {
  const valueToken = tokens[index + 1];
  if (valueToken === undefined) return null;

  const analysis = analyzeValueSegments(valueToken.segments);
  return {
    ...analysis,
    nextIndex: index + 1,
    replacement: {
      start: valueToken.start,
      end: valueToken.end,
      prefix: '',
    },
  };
}

// Parses a flag-with-inline-value form like `--input=prompt` or `-iprompt`.
// `prefix` is the exact literal to strip (`--input=` or `-i`).
function analyzeInlineValue(token, prefix) {
  const segments = getInlineValueSegments(token, prefix);
  if (segments === null) return null;

  const analysis = analyzeValueSegments(segments);
  return {
    ...analysis,
    replacement: {
      start: token.start,
      end: token.end,
      prefix,
    },
  };
}

// Tries separate-value first (`--long value` / `-s value`), falling back to
// inline forms (`--long=value`, `-svalue`). Returns the first match or null.
export function analyzeFlag(tokens, index, { short, long }) {
  const token = tokens[index];
  if (token === undefined) return null;

  if (isExactToken(token, short) || isExactToken(token, long)) {
    return analyzeSeparateValue(tokens, index);
  }

  return analyzeInlineValue(token, `${long}=`) ?? analyzeInlineValue(token, short);
}
