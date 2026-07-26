import { describe, it, expect, beforeEach } from 'vitest';
import { recordChatMessage, getMessageCount, clearChatActivity } from './twitchChatActivity';

beforeEach(() => {
  clearChatActivity();
});

describe('twitchChatActivity', () => {
  it('returns 0 for a channel with no recorded messages', () => {
    expect(getMessageCount('somestreamer')).toBe(0);
  });

  it('increments the count for a channel on each recorded message', () => {
    recordChatMessage('somestreamer');
    recordChatMessage('somestreamer');
    recordChatMessage('somestreamer');
    expect(getMessageCount('somestreamer')).toBe(3);
  });

  it('tracks counts independently per channel', () => {
    recordChatMessage('streamer-a');
    recordChatMessage('streamer-a');
    recordChatMessage('streamer-b');
    expect(getMessageCount('streamer-a')).toBe(2);
    expect(getMessageCount('streamer-b')).toBe(1);
  });

  it('clearChatActivity resets every channel to 0', () => {
    recordChatMessage('somestreamer');
    clearChatActivity();
    expect(getMessageCount('somestreamer')).toBe(0);
  });
});
