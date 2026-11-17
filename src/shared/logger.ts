import { createLogger as winstonCreateLogger, format, transports, type Logger } from 'winston';
import Transport from 'winston-transport';
import DailyRotateFile from 'winston-daily-rotate-file';
import { recordError } from './healthStore';

const LOG_LEVEL = process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'production' ? 'info' : 'debug');
/** Folder the log files are written to, relative to the working directory. */
export const LOG_DIR = 'logs';
/**
 * Days a debug log file is kept. The rotator prunes older ones only when it opens a file (at
 * startup or a new day's first write), so src/shared/debugLogging.ts also prunes them on a timer.
 */
export const DEBUG_LOG_RETENTION_DAYS = 3;
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

// Debug lines go to their own file, and only while debug logging is switched on (see
// setDebugLogFile and src/shared/debugLogging.ts), so they never bury combined-*.log or the
// journal. Silent until then.
const debugFile = IS_TEST
  ? null
  : new DailyRotateFile({
      dirname: LOG_DIR,
      filename: 'debug-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      level: 'debug',
      maxSize: '50m',
      maxFiles: `${DEBUG_LOG_RETENTION_DAYS}d`,
      zippedArchive: true,
      format: fileFormat,
      silent: true,
    });

const rootLogger = winstonCreateLogger({
  level: LOG_LEVEL,
  transports: [
    ...(debugFile
      ? [
          new DailyRotateFile({
            dirname: LOG_DIR,
            filename: 'combined-%DATE%.log',
            datePattern: 'YYYY-MM-DD',
            level: LOG_LEVEL,
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
          debugFile,
        ]
      : []),
    new transports.Console({
      level: LOG_LEVEL,
      format: consoleFormat,
    }),
    // Error-capturing feeds healthStore's error ring buffer for the owner health
    // dashboard/`!health` command — skipped in tests so a test asserting on error logs
    // doesn't also mutate healthStore's shared module state as a side effect.
    ...(!IS_TEST ? [new HealthStoreErrorTransport({ level: 'error' })] : []),
  ],
});

/**
 * Turns the separate debug log file (`logs/debug-YYYY-MM-DD.log`) on or off. While it's on, the
 * root logger passes debug entries through to it; the combined file and the console keep their own
 * `LOG_LEVEL`, so they don't fill up with debug lines. Use src/shared/debugLogging.ts, which also
 * persists the setting and switches it off again on time, rather than calling this directly.
 * @param enabled - True to write debug lines to the debug file, false to stop.
 * @returns False when there is no debug file to switch (under tests), true otherwise.
 */
export function setDebugLogFile(enabled: boolean): boolean {
  if (!debugFile) return false;
  debugFile.silent = !enabled;
  // Never lower an already more verbose LOG_LEVEL (e.g. `silly`); otherwise open up to debug.
  const levels = rootLogger.levels;
  const base = LOG_LEVEL in levels ? LOG_LEVEL : 'info';
  rootLogger.level = enabled && levels[base]! < levels.debug! ? 'debug' : base;
  return true;
}

/**
 * Returns a child logger tagged with the given module label.
 * @param module - Label shown on every line this logger writes, e.g. `Discord`.
 * @returns A winston child logger of the root logger.
 */
export function createLogger(module: string) {
  return rootLogger.child({ label: module });
}

/**
 * How long {@link flushLogs} waits for the log files to be written before giving up, so a stuck
 * disk can't hold up an exit.
 */
const LOG_FLUSH_TIMEOUT_MS = 2_000;

/**
 * Resolves once a `DailyRotateFile` transport has closed the file it was writing when the logger
 * ended. Ending the logger ends the transport and then calls its `close()`, which ends the current
 * file stream and emits a second `finish` once that file is written (the first `finish` is the
 * transport's own, when its queued entries have been handed to the stream). Listening from inside
 * `close()` catches that second one only, and a file rotated out earlier can't satisfy it.
 * @param transport - A file transport of the logger about to be ended.
 * @returns Resolves once the transport's current file has been written and closed.
 */
function fileClosed(transport: DailyRotateFile): Promise<void> {
  return new Promise((resolve) => {
    const close = transport.close?.bind(transport);
    transport.close = () => {
      transport.once('finish', () => resolve());
      if (close) close();
      else resolve();
    };
  });
}

/**
 * Formats a log entry rejected because its logger has ended, as the console would show it.
 * @param info - The winston log entry.
 * @returns One line (plus any stack trace) ending in a newline.
 */
function formatLateEntry(info: Record<string, unknown>): string {
  const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
  const fields: LogLineFields = {
    timestamp: new Date().toISOString(),
    label: text(info.label) ?? 'unknown',
    message: text(info.message) ?? '',
    stack: text(info.stack),
  };
  return `${formatLogLine(fields, (text(info.level) ?? 'info').toUpperCase())}\n`;
}

/**
 * Ends `logger` and waits for its log files to finish writing everything already logged, for up
 * to `timeoutMs`. The file transports write asynchronously, so a `process.exit()` straight after a
 * log call loses the line (often the reason for the exit). An entry logged after this starts can't
 * go through the ended logger, so it's written straight to stderr instead (journald keeps it) rather
 * than lost or raising a write-after-end error.
 * @param logger - The winston logger to end.
 * @param timeoutMs - Most milliseconds to wait for the files.
 * @returns Resolves once every file has been written, or at the time limit; never rejects.
 */
export async function endAndFlushLogger(logger: Logger, timeoutMs: number): Promise<void> {
  const fileTransports = logger.transports.filter((t): t is DailyRotateFile => t instanceof DailyRotateFile);
  const written = Promise.all(fileTransports.map(fileClosed));
  // Child loggers write through the parent's write(), so this catches their entries too.
  // (winston's streams come from readable-stream, which doesn't set `writableEnded`, hence the flag.)
  let ended = false;
  const write = logger.write.bind(logger);
  logger.write = ((info: Record<string, unknown>, ...rest: unknown[]) => {
    if (!ended) return (write as (...args: unknown[]) => boolean)(info, ...rest);
    process.stderr.write(formatLateEntry(info));
    return true;
  }) as typeof logger.write;
  ended = true;
  logger.end();
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); });
  try {
    await Promise.race([written, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

/** The flush in progress, so a second exit path waits on the same one instead of ending twice. */
let flushing: Promise<void> | null = null;

/**
 * Flushes the root logger's files before the process exits (see {@link endAndFlushLogger}). Call
 * it last: nothing logged afterwards reaches the files. Safe to call more than once.
 * @returns Resolves once the log files are written, or after {@link LOG_FLUSH_TIMEOUT_MS}.
 */
export function flushLogs(): Promise<void> {
  flushing ??= endAndFlushLogger(rootLogger, LOG_FLUSH_TIMEOUT_MS);
  return flushing;
}
