export const nowIsoString = (): string => new Date().toISOString();

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
