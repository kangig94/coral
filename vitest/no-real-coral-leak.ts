import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Capture the runner's home before worker isolation. Recursion catches new custody entries inside
// an existing ledger, as well as new stores and export leaves. Symlinks are recorded, never followed.
const coralRoot = join(homedir(), '.coral');
const guardedDirs = ['projects', 'projects-dev', 'gen2/run', 'gen2/data', 'exports'].map((name) =>
  join(coralRoot, name),
);

function snapshot(): Map<string, Set<string>> {
  const snap = new Map<string, Set<string>>();
  for (const dir of guardedDirs) {
    const entries = new Set<string>();
    const visit = (path: string): void => {
      let children;
      try {
        children = readdirSync(path, { withFileTypes: true });
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
      for (const entry of children) {
        const child = join(path, entry.name);
        entries.add(child);
        if (entry.isDirectory()) visit(child);
      }
    };
    visit(dir);
    snap.set(dir, entries);
  }
  return snap;
}

export default function setup(): () => void {
  const before = snapshot();
  return () => {
    const after = snapshot();
    const leaks: string[] = [];
    for (const dir of guardedDirs) {
      const seen = before.get(dir) ?? new Set<string>();
      for (const entry of after.get(dir) ?? new Set<string>()) {
        if (!seen.has(entry)) {
          leaks.push(entry);
        }
      }
    }
    if (leaks.length === 0) {
      return;
    }
    const noun = leaks.length === 1 ? 'entry' : 'entries';
    throw new Error(
      `Tests leaked ${leaks.length} ${noun} into the real ~/.coral tree:\n` +
        leaks.map((entry) => `  - ${entry}`).join('\n') +
        `\n\nPer-project data dirs must resolve through the composed runtime root ` +
        `(runtime.paths.projectData with an isolated coral root via createRealRuntime(flavor, { baseDir }) ` +
        `or SimulationRuntime { roots.coralRoot }), never the ambient home.`,
    );
  };
}
