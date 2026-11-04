import { runNamespaceSupervisor } from '#src/coordinator-launch/supervisor.js';
import { rmSync } from 'node:fs';

const [executable, runDir, invokingDir] = process.argv.slice(2);
rmSync(invokingDir, { recursive: true });
void runNamespaceSupervisor(executable, [], runDir).then((code) => {
  if (code !== 1) throw new Error(`Unexpected invalid-executable exit: ${code}`);
  process.stdout.write(process.cwd());
});
