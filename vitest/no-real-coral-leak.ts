import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Global test guard: fails the run if any test creates a NEW entry in the
// developer's real `~/.coral/projects`. Per-project data dirs must resolve
// through the composed runtime root — `runtime.paths.projectData`, isolated via
// `createRealRuntime(flavor, { baseDir })` or `SimulationRuntime { roots.coralRoot }` —
// never the ambient home. A leak here means a test bypassed that composition and
// wrote into the real home (the historical cause of stale `~/.coral/projects` dirs).
//
// Runs in the main Vitest process, so `homedir()` is the real home regardless of
// any per-file `vi.mock('node:os')`. Both flavor roots are guarded — prod writes
// under `projects`, dev under `projects-dev`.
const projectsDirs = [join(homedir(), '.coral', 'projects'), join(homedir(), '.coral', 'projects-dev')];

function snapshot(): Map<string, Set<string>> {
  const snap = new Map<string, Set<string>>();
  for (const dir of projectsDirs) {
    try {
      snap.set(dir, new Set(readdirSync(dir)));
    } catch {
      snap.set(dir, new Set());
    }
  }
  return snap;
}

export default function setup(): () => void {
  const before = snapshot();
  return () => {
    const after = snapshot();
    const leaks: string[] = [];
    for (const dir of projectsDirs) {
      const seen = before.get(dir) ?? new Set<string>();
      for (const entry of after.get(dir) ?? new Set<string>()) {
        if (!seen.has(entry)) {
          leaks.push(join(dir, entry));
        }
      }
    }
    if (leaks.length === 0) {
      return;
    }
    const noun = leaks.length === 1 ? 'entry' : 'entries';
    throw new Error(
      `Tests leaked ${leaks.length} ${noun} into the real ~/.coral project tree:\n` +
        leaks.map((entry) => `  - ${entry}`).join('\n') +
        `\n\nPer-project data dirs must resolve through the composed runtime root ` +
        `(runtime.paths.projectData with an isolated coral root via createRealRuntime(flavor, { baseDir }) ` +
        `or SimulationRuntime { roots.coralRoot }), never the ambient home.`,
    );
  };
}
