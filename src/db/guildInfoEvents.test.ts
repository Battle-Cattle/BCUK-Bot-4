import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockLog } = vi.hoisted(() => ({ mockLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../shared/logger', () => ({ createLogger: () => mockLog }));

import { onGuildInfoChanged, notifyGuildInfoChanged } from './guildInfoEvents';

beforeEach(() => { vi.clearAllMocks(); });

describe('guild-info events', () => {
  it('calls every listener with the guild ID, in registration order', () => {
    const calls: string[] = [];
    const off1 = onGuildInfoChanged((id) => calls.push(`a:${id}`));
    const off2 = onGuildInfoChanged((id) => calls.push(`b:${id}`));
    notifyGuildInfoChanged('guild-1');
    expect(calls).toEqual(['a:guild-1', 'b:guild-1']);
    off1();
    off2();
  });

  it('passes null through for a change that can touch any guild', () => {
    const listener = vi.fn();
    const off = onGuildInfoChanged(listener);
    notifyGuildInfoChanged(null);
    expect(listener).toHaveBeenCalledExactlyOnceWith(null);
    off();
  });

  it('stops calling a listener once it is removed, and leaves the others', () => {
    const removed = vi.fn();
    const kept = vi.fn();
    const off = onGuildInfoChanged(removed);
    const offKept = onGuildInfoChanged(kept);
    off();
    notifyGuildInfoChanged('guild-1');
    expect(removed).not.toHaveBeenCalled();
    expect(kept).toHaveBeenCalledOnce();
    offKept();
  });

  it('logs a listener that throws and still calls the rest, without throwing to the writer', () => {
    const boom = new Error('listener broke');
    const after = vi.fn();
    const offBad = onGuildInfoChanged(() => { throw boom; });
    const offAfter = onGuildInfoChanged(after);
    expect(() => notifyGuildInfoChanged('guild-1')).not.toThrow();
    expect(mockLog.error).toHaveBeenCalledWith(expect.any(String), boom);
    expect(after).toHaveBeenCalledOnce();
    offBad();
    offAfter();
  });

  it('copes with a listener removing itself while the notification runs', () => {
    const later = vi.fn();
    const off = onGuildInfoChanged(() => off());
    const offLater = onGuildInfoChanged(later);
    notifyGuildInfoChanged('guild-1');
    expect(later).toHaveBeenCalledOnce();
    offLater();
  });
});
