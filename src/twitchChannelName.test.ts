import { describe, it, expect } from 'vitest';
import { normalizeTwitchChannelName } from './twitchChannelName';

describe('normalizeTwitchChannelName', () => {
  it('returns lowercase name as-is when valid', () => {
    expect(normalizeTwitchChannelName('streamer')).toBe('streamer');
  });

  it('lowercases uppercase input', () => {
    expect(normalizeTwitchChannelName('StreamerName')).toBe('streamername');
  });

  it('strips a leading # prefix', () => {
    expect(normalizeTwitchChannelName('#mychannel')).toBe('mychannel');
  });

  it('trims surrounding whitespace before validating', () => {
    expect(normalizeTwitchChannelName('  chan1234  ')).toBe('chan1234');
  });

  it('returns null for names shorter than 4 characters', () => {
    expect(normalizeTwitchChannelName('abc')).toBeNull();
  });

  it('returns null for names longer than 25 characters', () => {
    expect(normalizeTwitchChannelName('a'.repeat(26))).toBeNull();
  });

  it('returns null when the name contains invalid characters', () => {
    expect(normalizeTwitchChannelName('my-channel')).toBeNull();
    expect(normalizeTwitchChannelName('my channel')).toBeNull();
    expect(normalizeTwitchChannelName('chan!')).toBeNull();
  });

  it('accepts names with underscores and digits', () => {
    expect(normalizeTwitchChannelName('my_channel_1')).toBe('my_channel_1');
  });

  it('returns null for an empty string', () => {
    expect(normalizeTwitchChannelName('')).toBeNull();
  });
});
