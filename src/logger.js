import pino from 'pino'
import pinoPretty from 'pino-pretty'
import { dbLogStream } from './services/admin/logTransport.js'

const isProd = process.env.NODE_ENV === 'production'
const useJson = process.env.LOG_FORMAT === 'json'
const level = process.env.LOG_LEVEL || (isProd ? 'info' : 'debug')

const LEVEL_LABELS = { 10: 'TRACE', 20: 'DEBUG', 30: 'INFO ', 40: 'WARN ', 50: 'ERROR', 60: 'FATAL' }
const SKIP_KEYS = new Set(['level', 'time', 'pid', 'hostname', 'module', 'err', 'msg'])

function messageFormat(log, messageKey) {
  const parts = []

  if (log.module) parts.push(`[${log.module}]`)

  const msg = log[messageKey]
  if (msg) parts.push(msg)

  const context = Object.entries(log)
    .filter(([k]) => !SKIP_KEYS.has(k))
    .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)

  if (context.length > 0) parts.push(` ${context.join(' ')}`)

  if (log.err && typeof log.err === 'object') {
    const { stack, message, type, ...rest } = log.err
    if (stack) {
      parts.push('\n    ' + stack.split('\n').join('\n    '))
    } else if (message) {
      parts.push(`\n    ${type || 'Error'}: ${message}`)
    }
    for (const [k, v] of Object.entries(rest)) {
      if (k === 'aggregateErrors') continue
      parts.push(`\n    ${k}: ${v}`)
    }
  }

  return parts.join(' ')
}

const prettyStream = useJson
  ? process.stdout
  : pinoPretty({
      colorize: true,
      translateTime: 'SYS:HH:MM:ss',
      ignore: 'pid,hostname,module',
      hideObject: true,
      messageFormat,
      customPrettifiers: {
        level(level) {
          return LEVEL_LABELS[level] || `L${level}`
        },
      },
    })

const logger = pino(
  {
    level,
    serializers: { err: pino.stdSerializers.err },
  },
  pino.multistream([
    { stream: prettyStream },
    { stream: dbLogStream, level: 'info' },
  ])
)

export default logger
