await new Promise((resolve) => setTimeout(resolve, Number(process.argv[2] ?? 0)));
process.on('SIGTERM', () => process.stdout.write('term\n'));
process.stdout.write('ready\n');
setInterval(() => {}, 1000);
