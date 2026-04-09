import Anthropic from '@anthropic-ai/sdk'
import config from '../../config.js'
import logger from '../../logger.js'

const log = logger.child({ module: 'anthropic' })

let client = null

export function getAnthropicClient() {
  if (!config.anthropic.apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not configured')
  }
  if (!client) {
    client = new Anthropic({ apiKey: config.anthropic.apiKey })
    log.info('Anthropic client initialized')
  }
  return client
}

export function isAnthropicAvailable() {
  return !!config.anthropic.apiKey
}
