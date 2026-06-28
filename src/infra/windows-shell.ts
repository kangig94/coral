function isBareCommandName(command: string): boolean {
  return !/[\\/]/.test(command);
}

export function windowsCommandName(command: string, platform: string = process.platform): string {
  const trimmed = command.trim();
  if (platform !== 'win32' || !isBareCommandName(trimmed)) {
    return command;
  }

  const normalized = trimmed.toLowerCase();
  if (normalized === 'codex' || normalized === 'claude') {
    return `${trimmed}.cmd`;
  }
  return trimmed;
}

export function shouldUseWindowsCommandShell(command: string, platform: string = process.platform): boolean {
  if (platform !== 'win32') {
    return false;
  }

  const normalized = command.trim().toLowerCase();
  return normalized.endsWith('.cmd') || normalized.endsWith('.bat');
}
