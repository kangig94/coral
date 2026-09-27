import { runCoordinatorSentinel } from './sentinel.js';

const [executable, ...args] = process.argv.slice(2);
if (executable === undefined) process.exitCode = 2;
else
  void runCoordinatorSentinel(executable, args).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`${String(error)}\n`);
      process.exitCode = 1;
    },
  );
