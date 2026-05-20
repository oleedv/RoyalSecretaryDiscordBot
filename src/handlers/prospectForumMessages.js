import { getProspectByForumThread, saveForumMessage } from '../services/prospect/prospectService.js';
import logger from '../logger.js';

const log = logger.child({ module: 'prospectForumMessages' });

export async function handleForumThread(message) {
  const prospect = await getProspectByForumThread(message.channel.id);
  if (!prospect) return false;

  await saveForumMessage(prospect.id, message);
  log.debug({ prospectId: prospect.id, messageId: message.id, isBot: message.author.bot }, 'Forum message saved');
  return true;
}
