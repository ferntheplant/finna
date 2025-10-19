import pino from 'pino';
import { mkdirSync } from 'fs';
import { join, dirname } from 'path';

// Ensure logs directory exists
const logsDir = join(process.cwd(), 'logs');
try {
  mkdirSync(logsDir, { recursive: true });
} catch (e) {
  // Directory already exists
}

// Determine log level from environment
const isDebug = process.env.DEBUG === '1' || process.env.DEBUG === 'true';
const logLevel = isDebug ? 'debug' : 'info';

// Create Pino logger with multistream: JSON to file, pretty to stdout
const logger = pino({
  level: logLevel,
  // Base fields to include in all logs
  base: {
    pid: process.pid,
    hostname: undefined, // Remove hostname for cleaner logs
  },
  // Timestamp format
  timestamp: () => `,"time":"${new Date().toISOString()}"`,
}, pino.multistream([
  // Stream 1: JSON to file for structured logging
  {
    level: logLevel,
    stream: pino.destination({
      dest: join(logsDir, 'app.log'),
      sync: false, // Async for performance
      mkdir: true,
    }),
  },
  // Stream 2: Pretty-print to stdout for development
  {
    level: logLevel,
    stream: pino.transport({
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'HH:MM:ss',
        ignore: 'pid,hostname',
        singleLine: false,
        messageFormat: '{msg}',
      },
    }),
  },
]));

// Create a child logger factory for different components
export function createLogger(component: string) {
  return logger.child({ component });
}

// Export the base logger
export default logger;

// Export a logger that conforms to Inngest's Logger interface
// This will be passed to the Inngest client
export const inngestLogger = {
  info: (...args: any[]) => {
    const [msg, ...rest] = args;
    if (typeof msg === 'string') {
      logger.info(rest.length > 0 ? { ...rest[0] } : {}, msg);
    } else {
      logger.info(msg);
    }
  },
  warn: (...args: any[]) => {
    const [msg, ...rest] = args;
    if (typeof msg === 'string') {
      logger.warn(rest.length > 0 ? { ...rest[0] } : {}, msg);
    } else {
      logger.warn(msg);
    }
  },
  error: (...args: any[]) => {
    const [msg, ...rest] = args;
    if (typeof msg === 'string') {
      logger.error(rest.length > 0 ? { ...rest[0] } : {}, msg);
    } else {
      logger.error(msg);
    }
  },
  debug: (...args: any[]) => {
    const [msg, ...rest] = args;
    if (typeof msg === 'string') {
      logger.debug(rest.length > 0 ? { ...rest[0] } : {}, msg);
    } else {
      logger.debug(msg);
    }
  },
};

