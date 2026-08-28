import { describe, it, expect, vi } from 'vitest';

vi.mock('./healthStore', () => ({
  recordError: vi.fn(),
}));

import { recordError } from './healthStore';
import { HealthStoreErrorTransport, createLogger } from './logger';

describe('HealthStoreErrorTransport', () => {
  it('forwards the log entry to healthStore.recordError under its label, then signals completion', async () => {
    const transport = new HealthStoreErrorTransport({ level: 'error' });
    const callback = vi.fn();
    const logged = new Promise<unknown>((resolve) => transport.once('logged', resolve));

    transport.log({ label: 'SomeModule', message: 'boom' }, callback);

    expect(recordError).toHaveBeenCalledWith('SomeModule', 'boom');
    expect(callback).toHaveBeenCalledOnce();
    await expect(logged).resolves.toEqual({ label: 'SomeModule', message: 'boom' });
  });

  it('falls back to "unknown"/empty string when label/message are absent', () => {
    const transport = new HealthStoreErrorTransport({ level: 'error' });
    transport.log({}, vi.fn());

    expect(recordError).toHaveBeenCalledWith('unknown', '');
  });
});

describe('createLogger', () => {
  it('returns a logger usable at every level without throwing', () => {
    const log = createLogger('TestModule');
    expect(() => {
      log.info('info message');
      log.warn('warn message');
      log.error('error message');
      log.debug('debug message');
    }).not.toThrow();
  });
});
