import { createLogger as winstonCreateLogger, format, transports } from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';

const LOG_LEVEL = process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'production' ? 'info' : 'debug');
const LOG_DIR = 'logs';
const IS_TEST = !!process.env.VITEST;

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
  ],
});

/** Returns a child logger tagged with the given module label. */
export function createLogger(module: string) {
  return rootLogger.child({ label: module });
}
