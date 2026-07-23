import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockLogger } from '../test-utils/loggerMock';

vi.mock('../shared/logger', () => ({ createLogger: mockLogger }));
vi.mock('../shared/config', () => ({
  TRIVIA_QUESTION_SECONDS: 20,
  TRIVIA_REVEAL_SECONDS: 8,
  TRIVIA_GAP_SECONDS: 8,
}));
vi.mock('./triviaService', () => ({
  fetchQuestion: vi.fn(),
  requestSessionToken: vi.fn(),
}));

import {
  notifyConnectionCountChanged,
  submitAnswer,
  registerTriviaPush,
  __resetTriviaGameForTests,
  type TriviaEvent,
} from './triviaGame';
import { fetchQuestion, requestSessionToken } from './triviaService';

const QUESTION_A = {
  category: 'Cat',
  question: 'What is the answer?',
  choices: [
    { letter: 'A' as const, text: 'Right' },
    { letter: 'B' as const, text: 'Wrong1' },
    { letter: 'C' as const, text: 'Wrong2' },
    { letter: 'D' as const, text: 'Wrong3' },
  ],
  correctLetter: 'A' as const,
};

const QUESTION_B = { ...QUESTION_A, question: 'Second question?' };

let pushMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  __resetTriviaGameForTests();
  pushMock = vi.fn();
  registerTriviaPush(pushMock as (groupKey: string, event: TriviaEvent) => void);
  vi.mocked(requestSessionToken).mockResolvedValue('session-token');
  vi.mocked(fetchQuestion).mockResolvedValue(QUESTION_A);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('notifyConnectionCountChanged', () => {
  it('starts a round cycle when the connection count goes from 0 to positive', async () => {
    notifyConnectionCountChanged('group-1', 1);
    await vi.advanceTimersByTimeAsync(0);

    expect(requestSessionToken).toHaveBeenCalledTimes(1);
    expect(fetchQuestion).toHaveBeenCalledWith('session-token');
    expect(pushMock).toHaveBeenCalledWith('group-1', expect.objectContaining({ type: 'question', question: QUESTION_A.question }));
  });

  it('does not start a new round for an already-active group when the count changes between positive values', async () => {
    notifyConnectionCountChanged('group-1', 1);
    await vi.advanceTimersByTimeAsync(0);
    pushMock.mockClear();
    vi.mocked(fetchQuestion).mockClear();

    notifyConnectionCountChanged('group-1', 3);
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchQuestion).not.toHaveBeenCalled();
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('cancels the round cycle and stops pushing once the count drops to 0', async () => {
    notifyConnectionCountChanged('group-1', 1);
    await vi.advanceTimersByTimeAsync(0);
    pushMock.mockClear();

    notifyConnectionCountChanged('group-1', 0);
    // Advance well past the question window — nothing further should ever be pushed.
    await vi.advanceTimersByTimeAsync(60_000);

    expect(pushMock).not.toHaveBeenCalled();
  });

  it('starts a fresh session (new scoreboard) when connections return after dropping to 0', async () => {
    notifyConnectionCountChanged('group-1', 1);
    await vi.advanceTimersByTimeAsync(0);
    submitAnswer('group-1', 'alice', 'Alice', 'a');

    notifyConnectionCountChanged('group-1', 0);
    notifyConnectionCountChanged('group-1', 1);
    await vi.advanceTimersByTimeAsync(0);

    // First correct answer in the fresh session should still count as a first-time win.
    const won = submitAnswer('group-1', 'alice', 'Alice', 'a');
    expect(won).toBe(true);
  });

  it('runs independent round cycles for different groups', async () => {
    vi.mocked(fetchQuestion).mockImplementation(async (token) => (token ? QUESTION_A : QUESTION_B));

    notifyConnectionCountChanged('group-1', 1);
    notifyConnectionCountChanged('group-2', 1);
    await vi.advanceTimersByTimeAsync(0);

    const calledGroups = pushMock.mock.calls.map((call) => call[0]);
    expect(calledGroups).toContain('group-1');
    expect(calledGroups).toContain('group-2');
  });
});

describe('round cycle timing', () => {
  it('reveals with no winner after the question window elapses unanswered', async () => {
    notifyConnectionCountChanged('group-1', 1);
    await vi.advanceTimersByTimeAsync(0);
    pushMock.mockClear();

    await vi.advanceTimersByTimeAsync(20_000);

    expect(pushMock).toHaveBeenCalledWith('group-1', expect.objectContaining({ type: 'reveal', winner: null }));
  });

  it('pushes idle then fetches the next question after the reveal window elapses', async () => {
    vi.mocked(fetchQuestion).mockResolvedValueOnce(QUESTION_A).mockResolvedValueOnce(QUESTION_B);

    notifyConnectionCountChanged('group-1', 1);
    await vi.advanceTimersByTimeAsync(20_000); // question -> reveal (no answer)
    pushMock.mockClear();

    await vi.advanceTimersByTimeAsync(8_000); // reveal -> idle
    expect(pushMock).toHaveBeenCalledWith('group-1', { type: 'idle' });

    await vi.advanceTimersByTimeAsync(8_000); // gap -> next round
    expect(pushMock).toHaveBeenCalledWith('group-1', expect.objectContaining({ type: 'question', question: QUESTION_B.question }));
  });

  it('skips to a fresh round after a gap when fetching the question fails', async () => {
    vi.mocked(fetchQuestion).mockRejectedValueOnce(new Error('network down')).mockResolvedValueOnce(QUESTION_A);

    notifyConnectionCountChanged('group-1', 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(pushMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(8_000); // gap before retry
    expect(pushMock).toHaveBeenCalledWith('group-1', expect.objectContaining({ type: 'question' }));
  });
});

describe('submitAnswer', () => {
  it('returns false and does not reveal early for a wrong answer', async () => {
    notifyConnectionCountChanged('group-1', 1);
    await vi.advanceTimersByTimeAsync(0);
    pushMock.mockClear();

    const won = submitAnswer('group-1', 'bob', 'Bob', 'b');

    expect(won).toBe(false);
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('returns true and reveals immediately for the first correct answer', async () => {
    notifyConnectionCountChanged('group-1', 1);
    await vi.advanceTimersByTimeAsync(0);
    pushMock.mockClear();

    const won = submitAnswer('group-1', 'alice', 'Alice', 'a');

    expect(won).toBe(true);
    expect(pushMock).toHaveBeenCalledWith('group-1', expect.objectContaining({
      type: 'reveal',
      winner: 'Alice',
      scoreboard: [{ username: 'Alice', score: 1 }],
    }));
  });

  it('ignores a second answer from the same user in the same round', async () => {
    notifyConnectionCountChanged('group-1', 1);
    await vi.advanceTimersByTimeAsync(0);

    const first = submitAnswer('group-1', 'alice', 'Alice', 'b');
    const second = submitAnswer('group-1', 'alice', 'Alice', 'a');

    expect(first).toBe(false);
    expect(second).toBe(false);
  });

  it('ignores every answer once a winner is already locked in', async () => {
    notifyConnectionCountChanged('group-1', 1);
    await vi.advanceTimersByTimeAsync(0);

    expect(submitAnswer('group-1', 'alice', 'Alice', 'a')).toBe(true);
    expect(submitAnswer('group-1', 'bob', 'Bob', 'a')).toBe(false);
  });

  it('is case-insensitive about the answer letter', async () => {
    notifyConnectionCountChanged('group-1', 1);
    await vi.advanceTimersByTimeAsync(0);

    expect(submitAnswer('group-1', 'alice', 'Alice', 'A')).toBe(true);
  });

  it('does nothing for a group with no active round', () => {
    expect(submitAnswer('unknown-group', 'alice', 'Alice', 'a')).toBe(false);
  });

  it('accumulates score across multiple rounds for the same user', async () => {
    vi.mocked(fetchQuestion).mockResolvedValue(QUESTION_A);
    notifyConnectionCountChanged('group-1', 1);
    await vi.advanceTimersByTimeAsync(0);

    submitAnswer('group-1', 'alice', 'Alice', 'a'); // round 1 win -> reveals immediately
    await vi.advanceTimersByTimeAsync(8_000); // reveal -> idle
    await vi.advanceTimersByTimeAsync(8_000); // gap -> round 2 starts

    pushMock.mockClear();
    submitAnswer('group-1', 'alice', 'Alice', 'a'); // round 2 win

    expect(pushMock).toHaveBeenCalledWith('group-1', expect.objectContaining({
      scoreboard: [{ username: 'Alice', score: 2 }],
    }));
  });
});
