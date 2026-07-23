import { createLogger } from '../shared/logger';

const log = createLogger('TriviaService');

// OpenTDB rate-limits by calling IP (not by session token) to one request per 5s — this app's
// server shares one outbound IP across every channel/group playing concurrently, so all requests
// must be serialized through the same throttle regardless of which group they're for.
const OPENTDB_MIN_INTERVAL_MS = 5_000;
const RATE_LIMIT_RETRY_DELAY_MS = 5_000;

const LETTERS = ['A', 'B', 'C', 'D'] as const;
export type TriviaLetter = (typeof LETTERS)[number];

export interface TriviaChoice {
  letter: TriviaLetter;
  text: string;
}

export interface TriviaQuestion {
  category: string;
  question: string;
  choices: TriviaChoice[];
  correctLetter: TriviaLetter;
}

interface OpenTdbQuestionResult {
  category: string;
  question: string;
  correct_answer: string;
  incorrect_answers: string[];
}

interface OpenTdbApiResponse {
  response_code: number;
  results: OpenTdbQuestionResult[];
}

interface OpenTdbTokenResponse {
  response_code: number;
  token?: string;
}

/** Resolves after `ms` milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

// Serializes every outbound OpenTDB request behind a single promise chain and enforces
// OPENTDB_MIN_INTERVAL_MS between the start of each one, regardless of which caller enqueued it.
let requestQueue: Promise<void> = Promise.resolve();
let lastRequestAt = 0;

/**
 * Runs `fn` serialized behind every other queued OpenTDB request, waiting out the remainder of
 * {@link OPENTDB_MIN_INTERVAL_MS} since the previous request started before invoking it.
 * @param fn - The OpenTDB request to run once its turn arrives.
 * @returns Whatever `fn` resolves (or rejects) with.
 */
function enqueueOpenTdbRequest<T>(fn: () => Promise<T>): Promise<T> {
  const result = requestQueue.then(async () => {
    const wait = OPENTDB_MIN_INTERVAL_MS - (Date.now() - lastRequestAt);
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
    return fn();
  });
  // Keep the chain alive even if this request rejects, so later queued requests still run in order.
  requestQueue = result.then(() => undefined, () => undefined);
  return result;
}

/** Decodes an OpenTDB `encode=base64` field back to plain UTF-8 text. */
function decodeBase64Field(value: string): string {
  return Buffer.from(value, 'base64').toString('utf-8');
}

/** Returns a new array with `items` in Fisher–Yates shuffled order. */
function shuffle<T>(items: T[]): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

/** Reset a session token that has exhausted every question for its query via `command=reset`. */
async function resetSessionToken(token: string): Promise<void> {
  const res = await fetch(`https://opentdb.com/api_token.php?command=reset&token=${encodeURIComponent(token)}`);
  if (!res.ok) throw new Error(`OpenTDB token reset failed: HTTP ${res.status}`);
  const data = await res.json() as OpenTdbTokenResponse;
  if (data.response_code !== 0) throw new Error(`OpenTDB token reset returned response_code ${data.response_code}`);
}

/**
 * Requests a fresh OpenTDB session token, used so a single playing session (one trivia group,
 * for the lifetime of its round cycle) doesn't see a repeat question.
 * @returns The new session token.
 */
export function requestSessionToken(): Promise<string> {
  return enqueueOpenTdbRequest(async () => {
    const res = await fetch('https://opentdb.com/api_token.php?command=request');
    if (!res.ok) throw new Error(`OpenTDB token request failed: HTTP ${res.status}`);
    const data = await res.json() as OpenTdbTokenResponse;
    if (data.response_code !== 0 || !data.token) throw new Error(`OpenTDB token request returned response_code ${data.response_code}`);
    return data.token;
  });
}

/**
 * Fetches one multiple-choice trivia question from Open Trivia DB, decodes its base64-encoded
 * fields, and shuffles its four answers into a stable A–D order.
 * @param sessionToken - An OpenTDB session token (see {@link requestSessionToken}), or null to
 *   fetch without one (repeat questions become possible).
 * @returns The decoded, shuffled question.
 * @throws If the request fails, or OpenTDB reports an error response_code the retry paths below
 *   don't recover from.
 */
export function fetchQuestion(sessionToken: string | null): Promise<TriviaQuestion> {
  return enqueueOpenTdbRequest(() => fetchQuestionOnce(sessionToken));
}

/**
 * Performs one (or, on a recoverable error, two) actual OpenTDB `api.php` request(s): a
 * `response_code` of 4 (token exhausted) resets the token and retries once; a `response_code` of
 * 5 (rate limited) waits {@link RATE_LIMIT_RETRY_DELAY_MS} and retries once; anything else
 * unexpected throws so the caller can skip this round rather than looping forever.
 */
async function fetchQuestionOnce(sessionToken: string | null, isRetry = false): Promise<TriviaQuestion> {
  const url = new URL('https://opentdb.com/api.php');
  url.searchParams.set('amount', '1');
  url.searchParams.set('type', 'multiple');
  url.searchParams.set('encode', 'base64');
  if (sessionToken) url.searchParams.set('token', sessionToken);

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`OpenTDB request failed: HTTP ${res.status}`);
  const data = await res.json() as OpenTdbApiResponse;

  if (data.response_code === 4 && sessionToken && !isRetry) {
    log.info('OpenTDB session token exhausted — resetting and retrying.');
    await resetSessionToken(sessionToken);
    return fetchQuestionOnce(sessionToken, true);
  }
  if (data.response_code === 5 && !isRetry) {
    log.warn('OpenTDB rate limit hit — retrying after backoff.');
    await sleep(RATE_LIMIT_RETRY_DELAY_MS);
    return fetchQuestionOnce(sessionToken, true);
  }
  if (data.response_code !== 0 || data.results.length === 0) {
    throw new Error(`OpenTDB returned response_code ${data.response_code}`);
  }

  const result = data.results[0];
  const question = decodeBase64Field(result.question);
  const category = decodeBase64Field(result.category);
  const correctText = decodeBase64Field(result.correct_answer);
  const incorrectTexts = result.incorrect_answers.map(decodeBase64Field);

  const shuffledTexts = shuffle([correctText, ...incorrectTexts]);
  const choices: TriviaChoice[] = shuffledTexts.map((text, i) => ({ letter: LETTERS[i], text }));
  const correctChoice = choices.find((c) => c.text === correctText);
  // Invariant: correctText was just placed into shuffledTexts above, so a match always exists.
  const correctLetter = correctChoice!.letter;

  return { category, question, choices, correctLetter };
}
