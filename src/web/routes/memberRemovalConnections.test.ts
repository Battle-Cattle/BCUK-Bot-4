import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockLogger } from '../../test-utils/loggerMock';

vi.mock('../../shared/logger', () => ({ createLogger: mockLogger }));
vi.mock('../../db', () => ({ findUser: vi.fn(), getGuildsForMember: vi.fn() }));
vi.mock('./dashboardStatusEvents', () => ({ disconnectGuildStatusConnectionsForMember: vi.fn() }));
vi.mock('./companionEvents', () => ({ disconnectCompanionConnections: vi.fn() }));

import { findUser, getGuildsForMember } from '../../db';
import { disconnectGuildStatusConnectionsForMember } from './dashboardStatusEvents';
import { disconnectCompanionConnections } from './companionEvents';
import { closeRemovedMemberConnections } from './memberRemovalConnections';

const GUILD_ID = '900000000000000001';
const MEMBER = '100000000000000001';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(findUser).mockResolvedValue({ discord_id: MEMBER, is_owner: false } as any);
  vi.mocked(getGuildsForMember).mockResolvedValue([]);
});

describe('closeRemovedMemberConnections (#1004)', () => {
  it('closes the member\'s dashboard status streams for the guild, and their companion streams when it was their last guild', async () => {
    await closeRemovedMemberConnections(GUILD_ID, MEMBER);
    expect(disconnectGuildStatusConnectionsForMember).toHaveBeenCalledWith(GUILD_ID, MEMBER);
    expect(getGuildsForMember).toHaveBeenCalledWith(MEMBER);
    expect(disconnectCompanionConnections).toHaveBeenCalledWith(MEMBER);
  });

  it('leaves the companion app connected when the member still belongs to another guild', async () => {
    vi.mocked(getGuildsForMember).mockResolvedValue([{ guild_id: '900000000000000002', name: 'g', voice_channel_id: null, access_level: 0 }] as any);
    await closeRemovedMemberConnections(GUILD_ID, MEMBER);
    expect(disconnectGuildStatusConnectionsForMember).toHaveBeenCalled();
    expect(disconnectCompanionConnections).not.toHaveBeenCalled();
  });

  it('leaves the bot owner\'s companion app connected with no guild left', async () => {
    vi.mocked(findUser).mockResolvedValue({ discord_id: MEMBER, is_owner: true } as any);
    await closeRemovedMemberConnections(GUILD_ID, MEMBER);
    expect(disconnectCompanionConnections).not.toHaveBeenCalled();
  });

  it('logs rather than throws when the access check fails', async () => {
    vi.mocked(getGuildsForMember).mockRejectedValue(new Error('db down'));
    await expect(closeRemovedMemberConnections(GUILD_ID, MEMBER)).resolves.toBeUndefined();
    expect(disconnectCompanionConnections).not.toHaveBeenCalled();
  });
});
