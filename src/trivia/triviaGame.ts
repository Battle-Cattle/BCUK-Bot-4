import { createLogger } from '../shared/logger';
import { fetchQuestion, requestSessionToken, type TriviaChoice, type TriviaQuestion } from './triviaService';
import { TRIVIA_QUESTION_SECONDS, TRIVIA_REVEAL_SECONDS, TRIVIA_GAP_SECONDS } from '../shared/config';

const log = createLogger('TriviaGame');

export interface TriviaScoreEntry {
  username: string;
  score: number;
}

export type TriviaEvent =
  | { type: 'question'; category: string; question: string; choices: TriviaChoice[]; questionSeconds: number }
  | {
      type: 'reveal';
      choices: TriviaChoice[];
      correctLetter: string;
      winner: string | null;
      scoreboard: TriviaScoreEntry[];
      revealSeconds: number;
    }
  | { type: 'idle' };

interface GroupTriviaState {
  phase: 'idle' | 'question' | 'reveal';
  /** Bumped on every start/stop so a timer scheduled against a now-superseded round never fires. */
  generation: number;
  connectionCount: number;
  sessionToken: string | null;
  current: TriviaQuestion | null;
  answered: Set<string>;
  winner: { login: string; displayName: string } | null;
  /** Session score per login, cleared whenever the group's connection count returns to 0 then back up. */
  scoreboard: Map<string, number>;
  displayNames: Map<string, string>;
  timer: NodeJS.Timeout | null;
}

const groups = new Map<string, GroupTriviaState>();

let pushFn: ((groupKey: string, event: TriviaEvent) => void) | null = null;

/** Stores the function used to push trivia events to a group's connected overlays. Call once from index.ts after the overlay route module is loaded. */
export function registerTriviaPush(push: (groupKey: string, event: TriviaEvent) => void): void {
  pushFn = push;
}

/** Pushes `event` to `groupKey` via the registered push function, if one has been registered. */
function push(groupKey: string, event: TriviaEvent): void {
  pushFn?.(groupKey, event);
}

/** Returns the group's state, creating a fresh idle one if this is the first time it's seen. */
function getOrCreateState(groupKey: string): GroupTriviaState {
  let state = groups.get(groupKey);
  if (!state) {
    state = {
      phase: 'idle',
      generation: 0,
      connectionCount: 0,
      sessionToken: null,
      current: null,
      answered: new Set(),
      winner: null,
      scoreboard: new Map(),
      displayNames: new Map(),
      timer: null,
    };
    groups.set(groupKey, state);
  }
  return state;
}

/** Clears a group's pending round timer, if any. */
function clearTimer(state: GroupTriviaState): void {
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
}

/** Returns the top `limit` scorers for a group, highest first. */
function topScores(scoreboard: Map<string, number>, displayNames: Map<string, string>, limit = 5): TriviaScoreEntry[] {
  return [...scoreboard.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([login, score]) => ({ username: displayNames.get(login) ?? login, score }));
}

/**
 * Notifies the game engine of the current total number of connected OBS sources for `groupKey`
 * (summed across every channel sharing that group — see `triviaSessionGroup.ts`). A transition
 * from 0 to more than 0 starts a fresh session (clears the scoreboard, requests a new OpenTDB
 * session token, kicks off the round cycle); a transition down to 0 cancels all pending timers
 * and drops in-flight round state, so nothing keeps polling OpenTDB while unwatched.
 * @param groupKey - The shared-chat session ID, or a channel's own login if playing solo.
 * @param count - Total connected overlay clients across every channel in the group right now.
 */
export function notifyConnectionCountChanged(groupKey: string, count: number): void {
  const state = getOrCreateState(groupKey);
  const wasZero = state.connectionCount === 0;
  state.connectionCount = count;

  if (count > 0 && wasZero) {
    state.generation++;
    state.scoreboard = new Map();
    state.displayNames = new Map();
    state.sessionToken = null;
    state.phase = 'idle';
    state.current = null;
    state.winner = null;
    state.answered = new Set();
    clearTimer(state);
    void startSession(groupKey, state, state.generation);
  } else if (count === 0 && !wasZero) {
    state.generation++;
    clearTimer(state);
    state.phase = 'idle';
    state.current = null;
    state.winner = null;
    state.answered = new Set();
  }
}

/** Obtains a fresh OpenTDB session token for a newly-started group session, then begins round 1. */
async function startSession(groupKey: string, state: GroupTriviaState, generation: number): Promise<void> {
  try {
    state.sessionToken = await requestSessionToken();
  } catch (err) {
    log.error(`Failed to obtain OpenTDB session token for group ${groupKey}:`, err);
    // Fall back to playing without a token — repeat questions become possible, but the game still runs.
  }
  if (state.generation !== generation) return; // connections changed again while awaiting the token
  await runRound(groupKey, state, generation);
}

/** Fetches the next question and pushes it, then schedules the reveal after the answer window. */
async function runRound(groupKey: string, state: GroupTriviaState, generation: number): Promise<void> {
  if (state.generation !== generation || state.connectionCount === 0) return;

  let question: TriviaQuestion;
  try {
    question = await fetchQuestion(state.sessionToken);
  } catch (err) {
    log.error(`Failed to fetch trivia question for group ${groupKey}:`, err);
    scheduleNext(state, generation, () => { void runRound(groupKey, state, generation); }, TRIVIA_GAP_SECONDS * 1000);
    return;
  }
  if (state.generation !== generation) return;

  state.phase = 'question';
  state.current = question;
  state.answered = new Set();
  state.winner = null;

  push(groupKey, {
    type: 'question',
    category: question.category,
    question: question.question,
    choices: question.choices,
    questionSeconds: TRIVIA_QUESTION_SECONDS,
  });

  scheduleNext(state, generation, () => revealRound(groupKey, state, generation), TRIVIA_QUESTION_SECONDS * 1000);
}

/** Pushes the reveal event (correct answer, winner if any, scoreboard) and schedules the next round. */
function revealRound(groupKey: string, state: GroupTriviaState, generation: number): void {
  if (state.generation !== generation) return;
  const question = state.current;
  if (!question || state.phase === 'reveal') return;

  state.phase = 'reveal';
  clearTimer(state);

  push(groupKey, {
    type: 'reveal',
    choices: question.choices,
    correctLetter: question.correctLetter,
    winner: state.winner?.displayName ?? null,
    scoreboard: topScores(state.scoreboard, state.displayNames),
    revealSeconds: TRIVIA_REVEAL_SECONDS,
  });

  scheduleNext(state, generation, () => {
    state.phase = 'idle';
    push(groupKey, { type: 'idle' });
    scheduleNext(state, generation, () => { void runRound(groupKey, state, generation); }, TRIVIA_GAP_SECONDS * 1000);
  }, TRIVIA_REVEAL_SECONDS * 1000);
}

/** Replaces a group's pending timer with a new one, guarded by `generation` so a superseded timer no-ops. */
function scheduleNext(state: GroupTriviaState, generation: number, fn: () => void, delayMs: number): void {
  clearTimer(state);
  state.timer = setTimeout(() => {
    if (state.generation !== generation) return;
    fn();
  }, delayMs);
}

/**
 * Records a chat answer for `groupKey`. No-ops (returns false) if no question round is active for
 * that group, the round already has a winner, or `login` already answered this round. A correct
 * answer locks in the winner, increments their session score, and immediately advances to the
 * reveal phase rather than waiting out the rest of the answer window.
 * @param groupKey - The answering channel's current trivia group key.
 * @param login - Twitch login of the answering user (used as the stable scoreboard key).
 * @param displayName - Twitch display name of the answering user (used for chat/overlay display).
 * @param letter - The single letter the user answered with (case-insensitive).
 * @returns True if this was the first correct answer for the round.
 */
export function submitAnswer(groupKey: string, login: string, displayName: string, letter: string): boolean {
  const state = groups.get(groupKey);
  if (!state || state.phase !== 'question' || !state.current) return false;
  if (state.winner !== null) return false;
  if (state.answered.has(login)) return false;

  state.answered.add(login);
  state.displayNames.set(login, displayName);

  if (letter.toUpperCase() !== state.current.correctLetter) return false;

  state.winner = { login, displayName };
  state.scoreboard.set(login, (state.scoreboard.get(login) ?? 0) + 1);
  revealRound(groupKey, state, state.generation);
  return true;
}

/** Test-only: clears all in-memory group state and cancels every pending timer. */
export function __resetTriviaGameForTests(): void {
  for (const state of groups.values()) clearTimer(state);
  groups.clear();
  pushFn = null;
}
