const TRANSIENT_RETRY_LIMIT = 2;
const TRANSIENT_RETRY_BASE_MS = 1_000;
const TRANSIENT_RETRY_STATUSES = [408, 425, 429, 500, 502, 503, 504];

export async function fetchWithTransientRetry(input: string, init?: RequestInit): Promise<Response> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= TRANSIENT_RETRY_LIMIT; attempt += 1) {
    try {
      const response = await fetch(input, init);
      if (response.ok || !TRANSIENT_RETRY_STATUSES.includes(response.status)) {
        return response;
      }
      lastError = new Error(`${response.status} ${response.statusText}`);
    } catch (error: unknown) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }

    if (attempt < TRANSIENT_RETRY_LIMIT) {
      const delayMs = TRANSIENT_RETRY_BASE_MS * 2 ** attempt;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw lastError ?? new Error('fetch failed');
}
