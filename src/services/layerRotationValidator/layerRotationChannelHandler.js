import logger from '../../logger.js';
import {
  getMode,
  getChannelId,
  getRoleIds,
  getLastValidHash,
  setLastValidHash,
  getLastKnownMode,
  replaceLiveEmbed,
} from './layerRotationValidatorScheduler.js';
import { parseLayerRotation, validateRotation, hashRotation } from './layerRotationValidatorService.js';
import config from '../../config.js';

const log = logger.child({ module: 'layerRotationChannel' });

const REJECT_DELETE_MS = 30_000;

function getSquadUtilsUrl() {
  return config.layerRotationValidator?.squadUtilsUrl
    || process.env.SQUAD_UTILS_URL
    || 'https://squadutils.org/api/v3/parse';
}

async function rejectInvalid(message) {
  await message.react('❌').catch(() => {});
  setTimeout(() => message.delete().catch(() => {}), REJECT_DELETE_MS);
}

export async function handleMessage(message) {
  const channelId = getChannelId();
  if (!channelId) return false;
  if (!message.guild) return false;
  if (message.channel?.id !== channelId) return false;

  if (message.author?.bot) return true;

  if (getMode() === 'sftp') {
    await message.delete().catch(() => {});
    return true;
  }

  const roleIds = getRoleIds();
  const memberRoles = message.member?.roles?.cache;
  const hasRole = !!memberRoles && roleIds.some((id) => memberRoles.has(id));

  if (!hasRole) {
    log.info({ userId: message.author?.id }, 'Unauthorised post in rotation channel - deleting');
    await message.delete().catch(() => {});
    return true;
  }

  const content = (message.content || '').trim();
  if (!content) {
    await message.delete().catch(() => {});
    return true;
  }

  const { cleanedText, lines } = parseLayerRotation(content);
  if (lines.length === 0) {
    await rejectInvalid(message);
    return true;
  }

  const result = await validateRotation(getSquadUtilsUrl(), cleanedText);
  if (result.fetchError) {
    log.warn({ fetchError: result.fetchError }, 'Squadutils API call failed for channel-posted rotation');
    await rejectInvalid(message);
    return true;
  }
  if (!result.ok) {
    await rejectInvalid(message);
    return true;
  }

  const modeForEmbed = getLastKnownMode() || 'Unknown';
  const hash = hashRotation(modeForEmbed, cleanedText);

  if (hash === getLastValidHash()) {
    await message.delete().catch(() => {});
    return true;
  }

  await message.delete().catch(() => {});
  const posted = await replaceLiveEmbed(message.client, { mode: modeForEmbed, lines, source: 'channel' });
  if (posted) {
    setLastValidHash(hash);
  }
  return true;
}
