import { createEmbed } from '../../utils/embed.js';
import { formatDuration } from './commsWatchState.js';

// Staff board: the violators-only list of our people in-game but not on Discord voice.
// Mentions inside an embed render as names without pinging, so the board stays passive.
export function buildBoardEmbed(violators, serverName, now) {
  const embed = createEmbed('Comms').setTitle(`Playing without Discord — ${serverName}`);
  const updated = `Updated <t:${Math.floor(now / 1000)}:R>`;
  if (!violators.length) {
    return embed.setColor(0x57f287).setDescription(`Everyone in-game is on comms.\n\n${updated}`);
  }
  const lines = violators
    .slice()
    .sort((a, b) => b.offCommsMs - a.offCommsMs)
    .map((v) => {
      const tag = v.kind === 'prospect' ? '[Prospect]' : '[Member]';
      const name = v.name ? ` \`${v.name}\`` : '';
      return `• <@${v.discordId}>${name} — ${formatDuration(v.offCommsMs)} — ${tag}`;
    });
  return embed.setColor(0xfee75c).setDescription(`${lines.join('\n')}\n\n${updated}`);
}

// Prospect alert posted into the prospect's staff ticket. Fires once when the prospect has
// been in-game past the off-comms threshold; the mentor ping lives in the message content.
// The threshold makes any duration/"since" line redundant (it's always ~the threshold), so
// the embed stays a single plain sentence.
export function buildProspectAlertEmbed({ userId, alias }, serverName) {
  return createEmbed('Prospect')
    .setTitle('Prospect not on Discord while in-game')
    .setColor(0xed4245)
    .setDescription(
      `<@${userId}>${alias ? ` (**${alias}**)` : ''} is playing on **${serverName}** but hasn't joined Discord voice.`,
    );
}
