import pino from 'pino';
import { dbLogStream } from './services/admin/logTransport.js';

const isDev = process.env.NODE_ENV !== 'production';

const prettyStream = isDev
  ? (await import('pino-pretty')).default({
      colorize: true,
      translateTime: 'SYS:yyyy-mm-dd HH:MM:ss',
      ignore: 'pid,hostname',
    })
  : process.stdout;

const logger = pino(
  { level: isDev ? 'debug' : 'info' },
  pino.multistream([
    { stream: prettyStream },
    { stream: dbLogStream, level: 'info' },
  ])
);

export default logger;
