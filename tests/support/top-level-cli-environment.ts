export function topLevelCliEnvironment(home: string, overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env, HOME: home, TMPDIR: home, ...overrides };
  delete environment.CORAL_CHILD;
  delete environment.CORAL_CHILD_PRINCIPAL_HANDLE;
  delete environment.CORAL_CHILD_CREDENTIAL_ID;
  delete environment.CORAL_CHILD_CREDENTIAL_KEY;
  delete environment.CORAL_JOB_ID;
  delete environment.CORAL_SESSION_ID;
  delete environment.CORAL_CLI_HANDOFF_DELEGATED;
  delete environment.CORAL_BACKEND_DISABLE_AUTOSTART;
  return environment;
}
