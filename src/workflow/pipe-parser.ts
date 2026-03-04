import type { SessionProvider } from '../runner/types.js';
import { providerIdentPattern } from '../shared/mcp-utils.js';
import type { PipeAtom, PipelineAST, PipeStep, PromptAtom } from './types.js';

const IDENTIFIER_PATTERN = /^[a-z][a-z0-9-]*$/;

function isProvider(value: string): value is SessionProvider {
  return providerIdentPattern.test(value);
}

function hasUnquotedParentheses(text: string): boolean {
  let inQuote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inQuote !== null && char === '\\' && text[i + 1] === inQuote) {
      i += 1;
      continue;
    }
    if ((char === '\'' || char === '"') && inQuote === null) {
      inQuote = char;
      continue;
    }
    if (char === inQuote) {
      inQuote = null;
      continue;
    }
    if (inQuote !== null) continue;
    if (char === '(' || char === ')') return true;
  }
  return false;
}

function splitByComma(text: string): string[] {
  const parts: string[] = [];
  let current = '';
  let inQuote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inQuote !== null && char === '\\' && text[i + 1] === inQuote) {
      current += char + text[i + 1];
      i += 1;
      continue;
    }
    if ((char === '\'' || char === '"') && inQuote === null) {
      inQuote = char;
      current += char;
      continue;
    }
    if (char === inQuote) {
      inQuote = null;
      current += char;
      continue;
    }
    if (inQuote !== null) {
      current += char;
      continue;
    }
    if (char === ',') {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts.map((part) => part.trim());
}

function hasTopLevelComma(text: string): boolean {
  let inQuote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inQuote !== null && char === '\\' && text[i + 1] === inQuote) {
      i += 1;
      continue;
    }
    if ((char === '\'' || char === '"') && inQuote === null) {
      inQuote = char;
      continue;
    }
    if (char === inQuote) {
      inQuote = null;
      continue;
    }
    if (inQuote !== null) continue;
    if (char === ',') return true;
  }
  return false;
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

  let provider: SessionProvider | undefined;
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

  let provider: SessionProvider | undefined;
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
  let inQuote: string | null = null;
  let current = '';

  for (let index = 0; index < expression.length; index += 1) {
    const char = expression[index];
    if (inQuote !== null && char === '\\' && expression[index + 1] === inQuote) {
      current += char + expression[index + 1];
      index += 1;
      continue;
    }
    if ((char === '\'' || char === '"') && inQuote === null) {
      inQuote = char;
      current += char;
      continue;
    }
    if (char === inQuote) {
      inQuote = null;
      current += char;
      continue;
    }
    if (inQuote !== null) {
      current += char;
      continue;
    }
    if (char === '(') {
      if (depth > 0) throw new Error('Nested groups are not allowed');
      depth += 1;
      current += char;
      continue;
    }
    if (char === ')') {
      if (depth === 0) throw new Error('Unmatched ")" in expression');
      depth -= 1;
      current += char;
      continue;
    }
    if (char === '-' && expression[index + 1] === '>' && depth === 0) {
      const step = current.trim();
      if (!step) throw new Error('Expected step expression before "->"');
      steps.push(step);
      current = '';
      index += 1;
      continue;
    }
    current += char;
  }

  if (depth !== 0) throw new Error('Unclosed "(" in expression');
  if (inQuote !== null) throw new Error('Unclosed quote in expression');

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
