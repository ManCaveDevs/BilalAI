import { pino } from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  transport:
    process.env.NODE_ENV === 'production' || !process.stdout.isTTY
      ? undefined
      : { target: 'pino-pretty', options: { translateTime: 'SYS:HH:MM:ss' } },
});

export type Logger = typeof logger;
