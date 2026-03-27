// Vitest threads pool registers SIGTERM/SIGINT handlers per test file in the
// same worker. With 60+ files this exceeds Node's default limit of 10. These
// handlers are cleaned up normally — raise the limit to suppress the warning.
process.setMaxListeners(100);
