import { truncate } from '../../shared/format-progress.js';
import type { PipeAtom } from '../ast.js';
import type { LaunchedAtom } from './shared.js';

export function stripElapsedPrefix(message: string): string {
  if (!message.startsWith('[')) return message;
  const closeBracket = message.indexOf('] ');
  if (closeBracket < 0) return message;
  return message.slice(closeBracket + 2);
}

export function atomTagName(atom: PipeAtom): string {
  return atom.kind === 'prompt' ? 'step-result' : atom.agent;
}

export function atomDiagnosticLabel(atom: PipeAtom, atomIndex: number): string {
  if (atom.kind === 'agent') return atom.agent;
  const truncated = truncate(atom.text, 20);
  return `prompt#${atomIndex}(${truncated})`;
}

export function formatAtomProgress(atom: LaunchedAtom, message: string): string {
  return `${atom.stepIndex}-${atom.agent.slice(0, 3)} ${message}`;
}
