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
export class HealthStoreErrorTransport extends Transport {
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

/** The fields of a log entry that {@link formatLogLine} prints. */
export interface LogLineFields {
  timestamp?: unknown;
  label?: unknown;
  message?: unknown;
  stack?: unknown;
}

/**
 * Formats one log line as `<timestamp> [<level>] [<label>] <message>`, followed by the stack
 * trace on the next lines when the entry carries one (an `Error` logged via `format.errors`).
 * @param fields The entry's timestamp, module label, message and optional stack.
 * @param levelText The level as it should be printed (upper-cased for files, colorized for the console).
 * @returns The formatted line.
 */
export function formatLogLine({ timestamp, label, message, stack }: LogLineFields, levelText: string): string {
  const base = `${String(timestamp)} [${levelText}] [${String(label)}] ${String(message)}`;
  return stack ? `${base}\n${String(stack)}` : base;
}

const fileFormat = format.combine(
  format.errors({ stack: true }),
  format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  format.printf((info) => formatLogLine(info, info.level.toUpperCase())),
);

const consoleFormat = format.combine(
  format.colorize(),
  format.errors({ stack: true }),
  format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  format.printf((info) => formatLogLine(info, info.level)),
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

/**
 * Returns a child logger tagged with the given module label.
 * @param module - Label shown on every line this logger writes, e.g. `Discord`.
 * @returns A winston child logger of the root logger.
 */
export function createLogger(module: string) {
  return rootLogger.child({ label: module });
}
