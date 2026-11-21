import {
  resolveEquippedTools as resolveTools,
  type EquippedToolSummary,
} from '../../clients/hooks/lib/equip-tools.mjs';
import type { Runtime } from '../runtime/ports.js';

export function resolveEquippedTools(runtime: Pick<Runtime, 'env' | 'storage'>): EquippedToolSummary[] {
  return resolveTools(runtime.env, runtime.storage);
}
