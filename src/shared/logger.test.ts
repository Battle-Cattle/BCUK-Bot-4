import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('./healthStore', () => ({
  recordError: vi.fn(),
}));

import { recordError } from './healthStore';
import { HealthStoreErrorTransport, createLogger, formatLogLine } from './logger';

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

describe('formatLogLine', () => {
  it('prints timestamp, level, label and message on one line', () => {
    expect(formatLogLine({ timestamp: '2026-10-13 12:00:00', label: 'Web', message: 'hello' }, 'INFO'))
      .toBe('2026-10-13 12:00:00 [INFO] [Web] hello');
  });

  it('appends the stack trace on the following lines when the entry has one', () => {
    expect(formatLogLine({ timestamp: 't', label: 'DB', message: 'boom', stack: 'Error: boom\n    at x' }, 'ERROR'))
      .toBe('t [ERROR] [DB] boom\nError: boom\n    at x');
  });
});

describe('root logger configuration (set at import)', () => {
  /** Re-imports logger.ts under the given env, with file rotation stubbed out so nothing is written to disk. */
  async function importLoggerWith(env: Record<string, string | undefined>) {
    vi.resetModules();
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    const rotateFileOptions: Array<{ filename: string; level?: string }> = [];
    // The finished line each stubbed log file would have written, keyed by file name.
    const writtenLines: Record<string, string[]> = {};
    vi.doMock('winston-daily-rotate-file', async () => {
      const { default: Transport } = await import('winston-transport');
      return {
        default: class extends Transport {
          private readonly filename: string;
          constructor(options: { filename: string; level?: string }) {
            super(options);
            this.filename = options.filename;
            rotateFileOptions.push(options);
          }
          log(info: Record<symbol, string>, callback: () => void) {
            (writtenLines[this.filename] ??= []).push(info[Symbol.for('message')]!);
            callback();
          }
        },
      };
    });
    const logger = await import('./logger.js');
    return { logger, rotateFileOptions, writtenLines };
  }

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.doUnmock('winston-daily-rotate-file');
    vi.resetModules();
  });

  it('defaults to info in production and debug elsewhere, and honours LOG_LEVEL', async () => {
    expect((await importLoggerWith({ LOG_LEVEL: undefined, NODE_ENV: 'production' })).logger.createLogger('x').level).toBe('info');
    expect((await importLoggerWith({ LOG_LEVEL: undefined, NODE_ENV: 'development' })).logger.createLogger('x').level).toBe('debug');
    expect((await importLoggerWith({ LOG_LEVEL: 'warn', NODE_ENV: 'production' })).logger.createLogger('x').level).toBe('warn');
  });

  it('adds the rotating combined/error log files and the health-store transport outside tests', async () => {
    const { logger, rotateFileOptions } = await importLoggerWith({ VITEST: '' });

    expect(rotateFileOptions.map((o) => [o.filename, o.level])).toEqual([
      ['combined-%DATE%.log', undefined],
      ['error-%DATE%.log', 'error'],
    ]);
    const transports = logger.createLogger('x').transports;
    expect(transports.some((t: unknown) => t instanceof logger.HealthStoreErrorTransport)).toBe(true);
  });

  it('writes upper-cased level lines to the log files', async () => {
    const { logger, writtenLines } = await importLoggerWith({ VITEST: '', LOG_LEVEL: 'info' });

    logger.createLogger('Web').warn('disk nearly full');

    expect(writtenLines['combined-%DATE%.log']).toEqual([
      expect.stringMatching(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \[WARN\] \[Web\] disk nearly full$/),
    ]);
    // Below the error file's level, so it never reaches it.
    expect(writtenLines['error-%DATE%.log']).toBeUndefined();
  });

  it('logs to the console only under tests', async () => {
    const { logger, rotateFileOptions } = await importLoggerWith({ VITEST: 'true' });

    expect(rotateFileOptions).toEqual([]);
    expect(logger.createLogger('x').transports).toHaveLength(1);
  });
});
