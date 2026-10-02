import { readFileSync } from 'node:fs';

export function childIsUninterruptible(pid: number): boolean {
  if (process.platform !== 'linux') return false;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat[stat.lastIndexOf(')') + 2] === 'D';
  } catch {
    return false;
  }
}

export function childHasExited(pid: number): boolean {
  if (process.platform !== 'linux') return false;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat[stat.lastIndexOf(')') + 2] === 'Z' || stat[stat.lastIndexOf(')') + 2] === 'X';
  } catch {
    return false;
  }
}
