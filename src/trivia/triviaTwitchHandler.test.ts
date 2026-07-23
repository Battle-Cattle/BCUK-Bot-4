import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockLogger } from '../test-utils/loggerMock';

vi.mock('../shared/logger', () => ({ createLogger: mockLogger }));
vi.mock('./triviaChannelGroup', () => ({ resolveTriviaGroupKey: vi.fn() }));
vi.mock('./triviaGame', () => ({ submitAnswer: vi.fn() }));

import { executeTriviaAnswerForTwitch, registerTriviaTwitchRuntime } from './triviaTwitchHandler';
import { resolveTriviaGroupKey } from './triviaChannelGroup';
import { submitAnswer } from './triviaGame';

const mockRuntime = { send: vi.fn().mockResolvedValue(undefined) };

function makeTags(username: string, displayName?: string) {
  return { username, 'display-name': displayName } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  registerTriviaTwitchRuntime(mockRuntime);
  vi.mocked(resolveTriviaGroupKey).mockReturnValue('group-1');
});

describe('executeTriviaAnswerForTwitch', () => {
  it('does nothing for an empty message', async () => {
    await executeTriviaAnswerForTwitch('somechannel', '', makeTags('viewer1'));
    expect(resolveTriviaGroupKey).not.toHaveBeenCalled();
  });

  it('ignores a message that is not a trivia answer', async () => {
    await executeTriviaAnswerForTwitch('somechannel', 'hello there', makeTags('viewer1'));
    expect(resolveTriviaGroupKey).not.toHaveBeenCalled();
    expect(submitAnswer).not.toHaveBeenCalled();
  });

  it('ignores a message with no username on the tags', async () => {
    await executeTriviaAnswerForTwitch('somechannel', '!a', { 'display-name': 'Viewer1' } as any);
    expect(submitAnswer).not.toHaveBeenCalled();
  });

  it.each(['!a', '!B', '!c', '!D'])('recognizes %s as a trivia answer', async (command) => {
    vi.mocked(submitAnswer).mockReturnValue(false);
    await executeTriviaAnswerForTwitch('somechannel', command, makeTags('viewer1', 'Viewer1'));
    expect(resolveTriviaGroupKey).toHaveBeenCalledWith('somechannel');
    expect(submitAnswer).toHaveBeenCalledWith('group-1', 'viewer1', 'Viewer1', command[1].toLowerCase());
  });

  it('falls back to the login when there is no display name', async () => {
    vi.mocked(submitAnswer).mockReturnValue(true);
    await executeTriviaAnswerForTwitch('somechannel', '!a', makeTags('viewer1'));
    expect(submitAnswer).toHaveBeenCalledWith('group-1', 'viewer1', 'viewer1', 'a');
  });

  it('does not announce anything when the answer did not win', async () => {
    vi.mocked(submitAnswer).mockReturnValue(false);
    await executeTriviaAnswerForTwitch('somechannel', '!a', makeTags('viewer1', 'Viewer1'));
    expect(mockRuntime.send).not.toHaveBeenCalled();
  });

  it('announces the winner in the originating channel when the answer won', async () => {
    vi.mocked(submitAnswer).mockReturnValue(true);
    await executeTriviaAnswerForTwitch('somechannel', '!a', makeTags('viewer1', 'Viewer1'));
    expect(mockRuntime.send).toHaveBeenCalledWith('somechannel', expect.stringContaining('Viewer1'));
  });

  it('does not throw when no runtime has been registered', async () => {
    vi.mocked(submitAnswer).mockReturnValue(true);
    registerTriviaTwitchRuntime(null as any);
    await expect(executeTriviaAnswerForTwitch('somechannel', '!a', makeTags('viewer1', 'Viewer1'))).resolves.toBeUndefined();
  });
});
