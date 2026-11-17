import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('./healthStore', () => ({
  recordError: vi.fn(),
}));

import { recordError } from './healthStore';
import fs from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createLogger as winstonCreateLogger } from 'winston';
import Transport from 'winston-transport';
import { HealthStoreErrorTransport, createLogger, endAndFlushLogger, flushLogs, formatLogLine, rotatingFileTransport } from './logger';

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
    const rotateFileOptions: Array<{ filename: string; level?: string; silent?: boolean }> = [];
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

  it('adds the rotating combined/error/debug log files and the health-store transport outside tests', async () => {
    const { logger, rotateFileOptions } = await importLoggerWith({ VITEST: '', LOG_LEVEL: 'info' });

    expect(rotateFileOptions.map((o) => [o.filename, o.level, o.silent])).toEqual([
      ['debug-%DATE%.log', 'debug', true],
      ['combined-%DATE%.log', 'info', undefined],
      ['error-%DATE%.log', 'error', undefined],
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

  it('writes debug lines only to the debug file, and only while it is switched on', async () => {
    const { logger, writtenLines } = await importLoggerWith({ VITEST: '', LOG_LEVEL: 'info' });
    const log = logger.createLogger('Audio');

    log.debug('before');
    expect(logger.setDebugLogFile(true)).toBe(true);
    log.debug('during');
    log.info('still info');
    logger.setDebugLogFile(false);
    log.debug('after');

    expect(writtenLines['debug-%DATE%.log']).toEqual([
      expect.stringMatching(/\[DEBUG\] \[Audio\] during$/),
      expect.stringMatching(/\[INFO\] \[Audio\] still info$/),
    ]);
    expect(writtenLines['combined-%DATE%.log']).toEqual([expect.stringMatching(/\[INFO\] \[Audio\] still info$/)]);
    expect(log.level).toBe('info');
  });

  it('never lowers a LOG_LEVEL that is already more verbose than debug', async () => {
    const { logger } = await importLoggerWith({ VITEST: '', LOG_LEVEL: 'silly' });

    logger.setDebugLogFile(true);
    expect(logger.createLogger('x').level).toBe('silly');
    logger.setDebugLogFile(false);
    expect(logger.createLogger('x').level).toBe('silly');
  });

  it('has no debug file to switch under tests', async () => {
    const { logger } = await importLoggerWith({ VITEST: 'true' });

    expect(logger.setDebugLogFile(true)).toBe(false);
  });

  it('logs to the console only under tests', async () => {
    const { logger, rotateFileOptions } = await importLoggerWith({ VITEST: 'true' });

    expect(rotateFileOptions).toEqual([]);
    expect(logger.createLogger('x').transports).toHaveLength(1);
  });
});

describe('endAndFlushLogger', () => {
  let dir: string | undefined;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  /** Whether a file name is a log file, including a size-rotated one (`x.log.1`). */
  const isLogFile = (name: string): boolean => /\.log(\.\d+)?$/.test(name);

  /** Reads every log file written to the temp folder, joined. */
  async function readLogFiles(folder: string): Promise<string> {
    const names = (await readdir(folder)).filter(isLogFile);
    const contents = await Promise.all(names.map((name) => readFile(path.join(folder, name), 'utf8')));
    return contents.join('');
  }

  it('waits until the last line logged is in the rotating log file', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'bcuk-logflush-'));
    const logger = winstonCreateLogger({
      transports: [rotatingFileTransport({ dirname: dir, filename: 'error-%DATE%.log', maxSize: '20m' })],
    });
    // Enough queued writes that the file can't have caught up synchronously.
    for (let i = 0; i < 500; i++) logger.error(`filler ${i} ${'x'.repeat(200)}`);
    logger.error('the fatal reason');

    await endAndFlushLogger(logger, 5_000);

    const written = await readLogFiles(dir);
    expect(written).toContain('the fatal reason');
    expect(written.trimEnd().split('\n')).toHaveLength(501);
  });

  it('waits for every file it rotated through to finish, not just the first or the last', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'bcuk-logflush-'));
    // Slow every write to the first file, so it finishes after the files rotated in after it: a
    // flush that waited only for the first 'finish', or only for the last file, would resolve early.
    const realCreate = fs.createWriteStream;
    let slowed = false;
    const createSpy = vi.spyOn(fs, 'createWriteStream').mockImplementation(((...args: Parameters<typeof fs.createWriteStream>) => {
      const stream = realCreate(...args);
      if (!slowed && String(args[0]).endsWith('.log')) {
        slowed = true;
        type Callback = (err?: Error | null) => void;
        const internals = stream as unknown as {
          _write: (chunk: unknown, encoding: unknown, callback: Callback) => void;
          _writev?: (chunks: unknown, callback: Callback) => void;
        };
        // Delays each write to disk itself, not just its completion callback.
        const write = internals._write.bind(stream);
        internals._write = (chunk, encoding, callback) => { setTimeout(() => write(chunk, encoding, callback), 100); };
        const writev = internals._writev?.bind(stream);
        if (writev) internals._writev = (chunks, callback) => { setTimeout(() => writev(chunks, callback), 100); };
      }
      return stream;
    }) as typeof fs.createWriteStream);
    try {
      const logger = winstonCreateLogger({
        // Small enough that these lines rotate through several files.
        transports: [rotatingFileTransport({ dirname: dir, filename: 'error-%DATE%.log', maxSize: '10k' })],
      });
      for (let i = 0; i < 300; i++) logger.error(`filler ${i} ${'x'.repeat(200)}`);
      logger.error('the fatal reason');

      await endAndFlushLogger(logger, 5_000);

      expect(slowed).toBe(true);
      expect((await readdir(dir)).filter(isLogFile).length).toBeGreaterThan(1);
      const written = await readLogFiles(dir);
      expect(written).toContain('the fatal reason');
      expect(written).toContain('filler 0 ');
      expect(written.trimEnd().split('\n')).toHaveLength(301);
    } finally {
      createSpy.mockRestore();
    }
  });

  it('writes an entry logged after the flush began to stderr instead of losing it', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'bcuk-logflush-'));
    const logger = winstonCreateLogger({
      transports: [rotatingFileTransport({ dirname: dir, filename: 'combined-%DATE%.log' })],
    });
    const child = logger.child({ label: 'Bot' });
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      child.info('before');

      const flushing = endAndFlushLogger(logger, 5_000);
      expect(() => child.error('late fatal reason')).not.toThrow();
      await flushing;

      expect(stderr).toHaveBeenCalledWith(expect.stringMatching(/\[ERROR\] \[Bot\] late fatal reason\n$/));
      const written = await readLogFiles(dir);
      expect(written).toContain('before');
      expect(written).not.toContain('late fatal reason');
    } finally {
      stderr.mockRestore();
    }
  });

  it('gives up at the time limit when a file never finishes', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'bcuk-logflush-'));
    const stuck = rotatingFileTransport({ dirname: dir, filename: 'never-%DATE%.log' });
    // A transport whose close never ends its file, so the file never reports it's finished.
    const realClose = stuck.close!.bind(stuck);
    stuck.close = () => {};
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const logger = winstonCreateLogger({ transports: [stuck] });

      let done = false;
      const flushing = endAndFlushLogger(logger, 2_000).then(() => { done = true; });
      await vi.advanceTimersByTimeAsync(1_999);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await flushing;
      expect(done).toBe(true);
    } finally {
      vi.useRealTimers();
      realClose();
    }
  });

  it('resolves straight away for a logger with no log files', async () => {
    class NullTransport extends Transport {
      log(_info: unknown, callback: () => void) { callback(); }
    }
    const logger = winstonCreateLogger({ transports: [new NullTransport()] });
    await expect(endAndFlushLogger(logger, 60_000)).resolves.toBeUndefined();
  });
});

describe('flushLogs', () => {
  it('flushes the root logger once, however many exit paths ask', async () => {
    const first = flushLogs();
    expect(flushLogs()).toBe(first);
    await expect(first).resolves.toBeUndefined();
  });
});
