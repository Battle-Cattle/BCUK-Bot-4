import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockLogger } from '../../test-utils/loggerMock';

vi.mock('../../db', () => ({
  getStreamerById: vi.fn(), findCachedAlertConfig: vi.fn(), recordStreamerEvent: vi.fn(),
}));
vi.mock('../../shared/logger', () => ({ createLogger: mockLogger }));

import {
  sendChatMessage, maybeSendChatMessage, maybePushAlert, recordAndPushDashboardEvent,
} from './twitchEventSubEffects';
import {
  registerEventSubTwitchRuntime, registerEventSubAlertRuntime, registerEventSubDashboardRuntime,
  registerEventSubCompanionRuntime, twitchRuntimeRegistry, alertRuntimeRegistry,
} from './twitchEventSubRuntime';
import { getStreamerById, findCachedAlertConfig, recordStreamerEvent } from '../../db';

const mockSend = vi.fn<(channel: string, message: string) => Promise<void>>();
registerEventSubTwitchRuntime({ send: mockSend });

const mockPushAlertEvent = vi.fn();
registerEventSubAlertRuntime({ pushAlertEvent: mockPushAlertEvent });

const mockPushDashboardEvent = vi.fn();
registerEventSubDashboardRuntime({ pushDashboardEvent: mockPushDashboardEvent });

const mockPushCompanionEvent = vi.fn();
registerEventSubCompanionRuntime({ pushCompanionEvent: mockPushCompanionEvent });

const ENABLED_ALERT = {
  enabled: true,
  message_template: '{display_name} {missing}',
  image_filename: 'img.png',
  sound_filename: null,
  duration_ms: 5000,
  text_animation: 'none',
} as any;

beforeEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  mockSend.mockResolvedValue(undefined);
  vi.mocked(recordStreamerEvent).mockResolvedValue(101);
  vi.mocked(getStreamerById).mockResolvedValue({ discord_id: '999' } as any);
});

describe('sendChatMessage', () => {
  it('returns true once the runtime sends the message', async () => {
    await expect(sendChatMessage('streamer', 'hi')).resolves.toBe(true);
    expect(mockSend).toHaveBeenCalledExactlyOnceWith('streamer', 'hi');
  });

  it('returns false and does not throw when the send fails', async () => {
    mockSend.mockRejectedValue(new Error('no access'));
    await expect(sendChatMessage('streamer', 'hi')).resolves.toBe(false);
  });

  it('returns false when no Twitch runtime is registered', async () => {
    vi.spyOn(twitchRuntimeRegistry, 'get').mockReturnValue(null);
    await expect(sendChatMessage('streamer', 'hi')).resolves.toBe(false);
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe('maybeSendChatMessage', () => {
  it('fills the template and sends it when enabled', async () => {
    await maybeSendChatMessage('streamer', true, 'Hi {name}', { name: 'Bob' });
    expect(mockSend).toHaveBeenCalledExactlyOnceWith('streamer', 'Hi Bob');
  });

  it('sends nothing when disabled', async () => {
    await maybeSendChatMessage('streamer', false, 'Hi {name}', { name: 'Bob' });
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe('maybePushAlert', () => {
  it('pushes an enabled alert with asset URLs, keeping unknown placeholders', async () => {
    vi.mocked(findCachedAlertConfig).mockResolvedValue(ENABLED_ALERT);
    await maybePushAlert('streamer', 7, 'follow', { display_name: 'Bob' });
    expect(findCachedAlertConfig).toHaveBeenCalledWith(7, 'follow');
    expect(mockPushAlertEvent).toHaveBeenCalledExactlyOnceWith('streamer', {
      type: 'follow',
      message: 'Bob {missing}',
      imageUrl: '/alerts/assets/7/img.png',
      soundUrl: null,
      durationMs: 5000,
      textAnimation: 'none',
    });
  });

  it('pushes nothing when the alert is disabled or has no config row', async () => {
    vi.mocked(findCachedAlertConfig).mockResolvedValueOnce({ ...ENABLED_ALERT, enabled: false });
    await maybePushAlert('streamer', 7, 'follow', {});
    vi.mocked(findCachedAlertConfig).mockResolvedValueOnce(null);
    await maybePushAlert('streamer', 7, 'follow', {});
    expect(mockPushAlertEvent).not.toHaveBeenCalled();
  });

  it('swallows a failed config lookup', async () => {
    vi.mocked(findCachedAlertConfig).mockRejectedValue(new Error('DB down'));
    await expect(maybePushAlert('streamer', 7, 'follow', {})).resolves.toBeUndefined();
    expect(mockPushAlertEvent).not.toHaveBeenCalled();
  });

  it('skips the config lookup when no alert runtime is registered', async () => {
    vi.spyOn(alertRuntimeRegistry, 'get').mockReturnValue(null);
    await maybePushAlert('streamer', 7, 'follow', {});
    expect(findCachedAlertConfig).not.toHaveBeenCalled();
  });
});

describe('recordAndPushDashboardEvent', () => {
  it('records the event, pushes it to the dashboard and forwards it to the companion app', async () => {
    await recordAndPushDashboardEvent(7, 'raid', 'Raider', '12 viewers');
    expect(recordStreamerEvent).toHaveBeenCalledWith(7, 'raid', 'Raider', '12 viewers');
    expect(mockPushDashboardEvent).toHaveBeenCalledExactlyOnceWith(7, expect.objectContaining({
      eventType: 'raid', displayName: 'Raider', detail: '12 viewers',
    }));
    expect(mockPushCompanionEvent).toHaveBeenCalledExactlyOnceWith('999', expect.objectContaining({
      type: 'raid', id: 101, displayName: 'Raider', detail: '12 viewers',
    }));
  });

  it('swallows a failed record without pushing anything', async () => {
    vi.mocked(recordStreamerEvent).mockRejectedValue(new Error('DB down'));
    await expect(recordAndPushDashboardEvent(7, 'follow', 'Bob', null)).resolves.toBeUndefined();
    expect(mockPushDashboardEvent).not.toHaveBeenCalled();
    expect(mockPushCompanionEvent).not.toHaveBeenCalled();
  });

  it('still pushes to the dashboard when the companion lookup fails', async () => {
    vi.mocked(getStreamerById).mockRejectedValue(new Error('DB down'));
    await expect(recordAndPushDashboardEvent(7, 'follow', 'Bob', null)).resolves.toBeUndefined();
    expect(mockPushDashboardEvent).toHaveBeenCalledOnce();
    expect(mockPushCompanionEvent).not.toHaveBeenCalled();
  });
});
