import { runNamespaceSupervisor } from './supervisor.js';

const [executable, ...args] = process.argv.slice(2);
if (executable === undefined || process.env.CORAL_SENTINEL_RUN_DIR === undefined) process.exit(2);
else
  void runNamespaceSupervisor(executable, args, process.env.CORAL_SENTINEL_RUN_DIR).then(
    (code) => {
      process.exit(code);
    },
    (error: unknown) => {
      process.stderr.write(`${String(error)}\n`, () => process.exit(1));
    },
  );
