/**
 * Winston Logger Configuration
 * Enterprise-grade logging with multiple transports and formats
 */

import winston from 'winston';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const LOG_FILE = process.env.LOG_FILE || 'logs/mcp-server.log';

// Custom format for console output with colors
const consoleFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.colorize(),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    let msg = `${timestamp} [${level}]: ${message}`;
    if (Object.keys(meta).length > 0) {
      msg += `\n${JSON.stringify(meta, null, 2)}`;
    }
    return msg;
  })
);

// JSON format for file output
const fileFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  winston.format.json()
);

// Create logger instance
export const logger = winston.createLogger({
  level: LOG_LEVEL,
  format: fileFormat,
  defaultMeta: { service: 'tareamov-mcp-server' },
  transports: [
    // Console transport
    new winston.transports.Console({
      format: consoleFormat
    }),
    
    // File transport for all logs
    new winston.transports.File({
      filename: LOG_FILE,
      maxsize: 10485760, // 10MB
      maxFiles: 5,
      tailable: true
    }),
    
    // Separate file for errors
    new winston.transports.File({
      filename: 'logs/error.log',
      level: 'error',
      maxsize: 10485760,
      maxFiles: 5,
      tailable: true
    })
  ]
});

// Create a stream for Morgan HTTP request logger
logger.stream = {
  write: (message) => {
    logger.info(message.trim());
  }
};

export default logger;
