import { createLogger as winstonCreateLogger, format, transports } from 'winston';
import Transport from 'winston-transport';
import DailyRotateFile from 'winston-daily-rotate-file';
import { recordError } from './healthStore';

const LOG_LEVEL = process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'production' ? 'info' : 'debug');
const LOG_DIR = 'logs';
const IS_TEST = !!process.env.VITEST;

/**
 * Winston transport that forwards every `error`-level log entry into `healthStore`'s bounded
 * error ring buffer, so the owner health dashboard/`!health` command surface the same
 * failures that already show up in the logs, without every call site having to remember to
 * call `recordError` itself. Only every level *at or above* the transport's configured
 * `level` is forwarded — set to `'error'` below so warn/info/debug entries never reach it.
 */
class HealthStoreErrorTransport extends Transport {
  /**
   * Winston's transport contract: forwards `info.message` to `healthStore.recordError`
   * under `info.label` (the module tag set via `createLogger(module)`), then signals
   * completion via the `logged` event as required by every `winston-transport` subclass.
   * @param info - The log entry; `label` is the module tag, `message` the formatted text.
   * @param callback - Invoked once handling is done, per the `winston-transport` contract.
   */
  log(info: { label?: string; message?: string }, callback: () => void): void {
    setImmediate(() => this.emit('logged', info));
    recordError(info.label ?? 'unknown', info.message ?? '');
    callback();
  }
}

const fileFormat = format.combine(
  format.errors({ stack: true }),
  format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  format.printf(({ timestamp, level, label, message, stack }) => {
    const base = `${timestamp} [${level.toUpperCase()}] [${label}] ${message}`;
    return stack ? `${base}\n${stack}` : base;
  }),
);

const consoleFormat = format.combine(
  format.colorize(),
  format.errors({ stack: true }),
  format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  format.printf(({ timestamp, level, label, message, stack }) => {
    const base = `${timestamp} [${level}] [${label}] ${message}`;
    return stack ? `${base}\n${stack}` : base;
  }),
);

const rootLogger = winstonCreateLogger({
  level: LOG_LEVEL,
  transports: [
    ...(!IS_TEST
      ? [
          new DailyRotateFile({
            dirname: LOG_DIR,
            filename: 'combined-%DATE%.log',
            datePattern: 'YYYY-MM-DD',
            maxSize: '20m',
            maxFiles: '14d',
            zippedArchive: true,
            format: fileFormat,
          }),
          new DailyRotateFile({
            dirname: LOG_DIR,
            filename: 'error-%DATE%.log',
            datePattern: 'YYYY-MM-DD',
            level: 'error',
            maxSize: '20m',
            maxFiles: '14d',
            zippedArchive: true,
            format: fileFormat,
          }),
        ]
      : []),
    new transports.Console({
      format: consoleFormat,
    }),
    // Error-capturing feeds healthStore's error ring buffer for the owner health
    // dashboard/`!health` command — skipped in tests so a test asserting on error logs
    // doesn't also mutate healthStore's shared module state as a side effect.
    ...(!IS_TEST ? [new HealthStoreErrorTransport({ level: 'error' })] : []),
  ],
});

/** Returns a child logger tagged with the given module label. */
export function createLogger(module: string) {
  return rootLogger.child({ label: module });
}
