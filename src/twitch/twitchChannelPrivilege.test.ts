import { describe, it, expect, beforeEach } from 'vitest';
import type { UserState } from '@twurple/chat';
import {
  onOwnUserState,
  isPrivilegedInChannel,
  clearPrivilegeState,
  __resetTwitchPrivilegedChannelsForTests,
} from './twitchChannelPrivilege';

/** Builds a minimal fake raw `USERSTATE` message, mirroring the real ircv3 shape. */
function makeUserState(channel: string, rawBadges?: string): UserState {
  return { channel, tags: new Map(rawBadges ? [['badges', rawBadges]] : []) } as unknown as UserState;
}

beforeEach(() => {
  __resetTwitchPrivilegedChannelsForTests();
});

describe('isPrivilegedInChannel', () => {
  it('defaults to false for a channel with no observed USERSTATE', () => {
    expect(isPrivilegedInChannel('streamer')).toBe(false);
  });
});

describe('onOwnUserState', () => {
  it('marks a channel privileged when the badges include moderator', () => {
    onOwnUserState(makeUserState('#streamer', 'moderator/1'));
    expect(isPrivilegedInChannel('streamer')).toBe(true);
  });

  it('marks a channel privileged when the badges include vip', () => {
    onOwnUserState(makeUserState('#streamer', 'vip/1'));
    expect(isPrivilegedInChannel('streamer')).toBe(true);
  });

  it('marks a channel privileged when the badges include broadcaster', () => {
    onOwnUserState(makeUserState('#streamer', 'broadcaster/1'));
    expect(isPrivilegedInChannel('streamer')).toBe(true);
  });

  it('leaves a channel non-privileged when badges contain none of the privileged roles', () => {
    onOwnUserState(makeUserState('#streamer', 'subscriber/12'));
    expect(isPrivilegedInChannel('streamer')).toBe(false);
  });

  it('leaves a channel non-privileged when the badges tag is absent', () => {
    onOwnUserState(makeUserState('#streamer'));
    expect(isPrivilegedInChannel('streamer')).toBe(false);
  });

  it('demotes a previously-privileged channel once a later USERSTATE drops the badge', () => {
    onOwnUserState(makeUserState('#streamer', 'moderator/1'));
    expect(isPrivilegedInChannel('streamer')).toBe(true);
    onOwnUserState(makeUserState('#streamer', 'subscriber/12'));
    expect(isPrivilegedInChannel('streamer')).toBe(false);
  });

  it('ignores a USERSTATE for a channel name that fails to normalize', () => {
    onOwnUserState(makeUserState('#!!invalid', 'moderator/1'));
    expect(isPrivilegedInChannel('!!invalid')).toBe(false);
  });

  it('tracks privilege independently per channel', () => {
    onOwnUserState(makeUserState('#alpha', 'moderator/1'));
    onOwnUserState(makeUserState('#beta', 'subscriber/1'));
    expect(isPrivilegedInChannel('alpha')).toBe(true);
    expect(isPrivilegedInChannel('beta')).toBe(false);
  });
});

describe('clearPrivilegeState', () => {
  it('resets every tracked channel back to non-privileged', () => {
    onOwnUserState(makeUserState('#streamer', 'moderator/1'));
    expect(isPrivilegedInChannel('streamer')).toBe(true);
    clearPrivilegeState();
    expect(isPrivilegedInChannel('streamer')).toBe(false);
  });
});
