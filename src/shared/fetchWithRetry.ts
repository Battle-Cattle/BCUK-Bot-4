import type { Logger } from 'winston';

/** HTTP status codes treated as transient failures on an upstream API, worth a retry. */
const TRANSIENT_STATUS_CODES = new Set([502, 503, 504]);

/**
 * Calls `fetch`, retrying up to `maxRetries` times (with a short fixed delay
 * between attempts) when the response status is one of `TRANSIENT_STATUS_CODES`.
 * Some upstream APIs (e.g. Discord's OAuth2 endpoints) intermittently return 503s
 * under load; a transient failure there shouldn't fail the caller's flow outright.
 * Non-transient error statuses (and thrown errors) are returned/thrown immediately
 * without retrying.
 * @param input - `fetch` URL/request.
 * @param init - `fetch` options.
 * @param log - Logger used to record retry attempts.
 * @param maxRetries - Number of retry attempts after the initial try (default 2).
 * @param retryDelayMs - Delay between attempts, in milliseconds (default 500).
 * @returns The `fetch` `Response`, which may still be non-ok if retries were exhausted.
 */
export async function fetchWithRetry(
  input: string,
  init: RequestInit,
  log: Logger,
  maxRetries = 2,
  retryDelayMs = 500,
): Promise<Response> {
  let lastResponse: Response;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    lastResponse = await fetch(input, init);
    if (lastResponse.ok || !TRANSIENT_STATUS_CODES.has(lastResponse.status)) {
      return lastResponse;
    }
    if (attempt < maxRetries) {
      log.warn(`Transient ${lastResponse.status} from ${input}, retrying (attempt ${attempt + 1}/${maxRetries})...`);
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
  return lastResponse!;
}
