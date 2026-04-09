import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { createEmbed } from '../../utils/embed.js';
import { ensurePanel } from '../../utils/panelManager.js';
import config from '../../config.js';

export function buildPanelMessage() {
  const embed = createEmbed('Prospect')
    .setTitle('Royal Battalion - Join RB')
    .setDescription(
      'Do you want to be a part of our community and become an RB Member? ' +
      'Read below to make sure we are right for you!'
    )
    .setColor(0x57f287)
    .addFields(
      {
        name: 'Our Ethos',
        value:
          'Royal Battalion is a community first and foremost. Our core value is **respect** - ' +
          'for your fellow members and the people you meet in-game and on Discord.\n\n' +
          'Harassment, bigotry or hate speech are never acceptable. ' +
          'We do not allow controversial topics within the server or Discord.\n\n' +
          'When you wear RB tags, you represent the entire community. ' +
          'Misconduct on any server will have consequences.',
      },
      {
        name: 'Member Benefits',
        value:
          '- Friendly international community (mainly Europe)\n' +
          '- RB-only squads - fewer dealings with unorganised blueberries\n' +
          '- Server whitelist (priority queue)\n' +
          '- Member-only Discord channels, tips & tricks, tech support\n' +
          '- Dedicated community team always there for a chat\n' +
          '- Opportunities to get involved (admin, recruitment, events)\n' +
          '- Internal events and early access to partner events',
      },
      {
        name: 'Requirements',
        value:
          '- Minimum **100 hours** in Squad\n' +
          '- Intermediate English and a **working microphone**\n' +
          '- Follow and uphold our community, Discord and server rules\n' +
          '- Stay active and involved when you can\n' +
          '- Minimum age of **18** (non-negotiable)',
      },
      {
        name: 'Prospect Phase (4 weeks)',
        value:
          'During your prospect phase we ask for **16 hours** on our Squad server and in the Discord, ' +
          'as well as making an effort to get to know our current members.',
      },
      {
        name: 'How to Apply',
        value:
          '1. Press the **Join RB** button below\n' +
          '2. Have your 17-digit Steam ID ready ([SteamID.com](https://www.steamid.com/))\n' +
          '3. Enter your Steam ID and submit the application form\n' +
          '4. A Mentor will claim your ticket and invite you for a chat',
      },
    );

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('prospect_apply')
      .setLabel('Join RB')
      .setStyle(ButtonStyle.Success)
  );

  return { embeds: [embed], components: [row] };
}

export async function ensureProspectPanel(client) {
  await ensurePanel(client, config.prospects.panelChannelId, 'prospect_apply', buildPanelMessage, 'Prospect');
}
