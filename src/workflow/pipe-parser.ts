import { providerIdentPattern } from '../shared/mcp-utils.js';
import type { PipeAtom, PipelineAST, PipeStep, PromptAtom } from './types.js';

const IDENTIFIER_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
type ScanVisitor = (char: string, index: number, inQuote: string | null) => boolean | void;

/**
 * Iterate characters with quote-aware state tracking.
 * The visitor receives every character, including quote delimiters and escape pairs.
 * Return true from the visitor to stop early.
 */
function scanQuoteAware(text: string, visitor: ScanVisitor): string | null {
  let inQuote: string | null = null;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (inQuote !== null && char === '\\' && text[index + 1] === inQuote) {
      if (visitor(char, index, inQuote)) return inQuote;
      index += 1;
      if (visitor(text[index], index, inQuote)) return inQuote;
      continue;
    }

    if ((char === '\'' || char === '"') && inQuote === null) {
      inQuote = char;
      if (visitor(char, index, inQuote)) return inQuote;
      continue;
    }

    if (char === inQuote) {
      if (visitor(char, index, inQuote)) return inQuote;
      inQuote = null;
      continue;
    }

    if (visitor(char, index, inQuote)) return inQuote;
  }

  return inQuote;
}

function isProvider(value: string): boolean {
  return providerIdentPattern.test(value);
}

function hasUnquotedChar(text: string, target: string): boolean {
  let found = false;

  scanQuoteAware(text, (char, _index, inQuote) => {
    if (inQuote === null && char === target) {
      found = true;
      return true;
    }
  });

  return found;
}

function hasUnquotedParentheses(text: string): boolean {
  return hasUnquotedChar(text, '(') || hasUnquotedChar(text, ')');
}

function splitByComma(text: string): string[] {
  const parts: string[] = [];
  let current = '';

  scanQuoteAware(text, (char, _index, inQuote) => {
    if (inQuote === null && char === ',') {
      parts.push(current);
      current = '';
      return;
    }

    current += char;
  });

  parts.push(current);
  return parts.map((part) => part.trim());
}

function hasTopLevelComma(text: string): boolean {
  return hasUnquotedChar(text, ',');
}

function parsePromptLiteral(atomText: string): PromptAtom {
  const quoteChar = atomText[0];
  let text = '';
  let closeIndex = -1;
  for (let i = 1; i < atomText.length; i++) {
    if (atomText[i] === '\\' && atomText[i + 1] === quoteChar) {
      text += quoteChar;
      i += 1;
      continue;
    }
    if (atomText[i] === quoteChar) {
      closeIndex = i;
      break;
    }
    text += atomText[i];
  }
  if (closeIndex === -1) throw new Error('Unclosed quote in expression');
  if (!text) throw new Error('Empty prompt literal');
  const rest = atomText.slice(closeIndex + 1).trim();

  let provider: string | undefined;
  if (rest.startsWith('@')) {
    const providerText = rest.slice(1).trim();
    if (!providerText) throw new Error(`Expected provider after "@": "${atomText}"`);
    if (!isProvider(providerText)) throw new Error(`Unknown provider "${providerText}" in "${atomText}"`);
    provider = providerText;
  } else if (rest) {
    throw new Error(`Invalid prompt literal "${atomText}"`);
  }

  return { kind: 'prompt', text, provider };
}

function parseAtom(rawAtom: string): PipeAtom {
  const atomText = rawAtom.trim();
  if (!atomText) throw new Error('Expected atom');

  if (atomText.startsWith('\'') || atomText.startsWith('"')) {
    return parsePromptLiteral(atomText);
  }

  if (atomText.includes('(') || atomText.includes(')')) {
    throw new Error(`Nested groups are not allowed: "${atomText}"`);
  }

  const atFirst = atomText.indexOf('@');
  const atLast = atomText.lastIndexOf('@');
  if (atFirst !== atLast) {
    throw new Error(`Invalid atom "${atomText}"`);
  }

  let provider: string | undefined;
  let qualified = atomText;
  if (atFirst >= 0) {
    qualified = atomText.slice(0, atFirst).trim();
    const providerText = atomText.slice(atFirst + 1).trim();
    if (!providerText) throw new Error(`Expected provider after "@": "${atomText}"`);
    if (!isProvider(providerText)) throw new Error(`Unknown provider "${providerText}" in "${atomText}"`);
    provider = providerText;
  }

  if (!qualified) throw new Error(`Expected agent name in "${atomText}"`);

  const colonFirst = qualified.indexOf(':');
  const colonLast = qualified.lastIndexOf(':');
  if (colonFirst !== colonLast) throw new Error(`Invalid atom "${atomText}"`);

  let namespace: string | undefined;
  let agent = qualified;

  if (colonFirst >= 0) {
    namespace = qualified.slice(0, colonFirst).trim();
    agent = qualified.slice(colonFirst + 1).trim();
    if (!namespace) throw new Error(`Expected namespace before ":" in "${atomText}"`);
    if (!agent) throw new Error(`Expected agent name after ":" in "${atomText}"`);
  }

  if (namespace && !IDENTIFIER_PATTERN.test(namespace)) {
    throw new Error(`Invalid namespace "${namespace}" in "${atomText}"`);
  }
  if (!IDENTIFIER_PATTERN.test(agent)) {
    throw new Error(`Invalid agent "${agent}" in "${atomText}"`);
  }

  return { kind: 'agent', namespace, agent, provider };
}

function parseParallelStep(rawStep: string): PipeStep {
  const content = rawStep.slice(1, -1).trim();
  if (!content) throw new Error('Parallel group cannot be empty');
  if (hasUnquotedParentheses(content)) {
    throw new Error(`Nested groups are not allowed: "${rawStep}"`);
  }

  const parts = splitByComma(content);
  if (parts.some((part) => part.length === 0)) {
    throw new Error(`Expected atom name in parallel group "${rawStep}"`);
  }

  return parts.map((part) => parseAtom(part));
}

function parseStep(rawStep: string): PipeStep {
  const stepText = rawStep.trim();
  if (!stepText) throw new Error('Expected step expression');

  const startsGroup = stepText.startsWith('(');
  const endsGroup = stepText.endsWith(')');

  if (startsGroup || endsGroup) {
    if (!startsGroup || !endsGroup) throw new Error(`Mismatched parentheses in step "${stepText}"`);
    return parseParallelStep(stepText);
  }

  if (hasTopLevelComma(stepText))
    throw new Error(`Parallel steps must be wrapped in parentheses: "${stepText}"`);

  return [parseAtom(stepText)];
}

function splitSteps(expression: string): string[] {
  const steps: string[] = [];
  let depth = 0;
  let current = '';
  let pendingDash = false;

  const finalQuote = scanQuoteAware(expression, (char, _index, inQuote) => {
    if (pendingDash) {
      pendingDash = false;
      if (inQuote === null && char === '>' && depth === 0) {
        const step = current.trim();
        if (!step) throw new Error('Expected step expression before "->"');
        steps.push(step);
        current = '';
        return;
      }
      current += '-';
    }

    if (inQuote !== null) {
      current += char;
      return;
    }

    if (char === '(') {
      if (depth > 0) throw new Error('Nested groups are not allowed');
      depth += 1;
      current += char;
      return;
    }

    if (char === ')') {
      if (depth === 0) throw new Error('Unmatched ")" in expression');
      depth -= 1;
      current += char;
      return;
    }

    if (char === '-') {
      pendingDash = true;
      return;
    }

    current += char;
  });

  if (depth !== 0) throw new Error('Unclosed "(" in expression');
  if (finalQuote !== null) throw new Error('Unclosed quote in expression');
  if (pendingDash) current += '-';

  const lastStep = current.trim();
  if (!lastStep) throw new Error('Expected step expression after "->"');
  steps.push(lastStep);
  return steps;
}

export function parseExpression(expression: string): PipelineAST {
  const trimmed = expression.trim();
  if (!trimmed) throw new Error('Expression required');
  const steps = splitSteps(trimmed);
  return steps.map((step) => parseStep(step));
}
