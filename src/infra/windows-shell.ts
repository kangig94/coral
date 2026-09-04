function isBareCommandName(command: string): boolean {
  return !/[\\/]/.test(command);
}

export function windowsCommandName(command: string, platform: string = process.platform): string {
  const trimmed = command.trim();
  if (platform !== 'win32' || !isBareCommandName(trimmed)) {
    return command;
  }

  return trimmed.toLowerCase().endsWith('.cmd') ? trimmed : `${trimmed}.cmd`;
}

export function shouldUseWindowsCommandShell(command: string, platform: string = process.platform): boolean {
  if (platform === 'win32') {
    throw new Error(
      `Windows command-shell launch is unsupported because Coral cannot contain the resulting process tree: ${command}`,
    );
  }
  return false;
}
