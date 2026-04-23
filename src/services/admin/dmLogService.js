import { EmbedBuilder } from 'discord.js';
import config from '../../config.js';
import logger from '../../logger.js';

const log = logger.child({ module: 'dmLogService' });

let client = null;
let channelId = null;

export function init(discordClient) {
  client = discordClient;
  channelId = config.alerts?.channelId || null;
  if (!channelId) log.warn('No config.alerts.channelId set; DM logs will be skipped.');
}

export async function logUnmatchedDm(message) {
  if (!client || !channelId) return;
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel) return;
  try {
    const embed = await buildUnmatchedDmEmbed(message);
    await channel.send({ embeds: [embed] });
  } catch (err) {
    log.warn({ err, userId: message.author?.id }, 'Failed to send DM log embed');
  }
}

export async function logDmInteraction(interaction, kind) {
  if (!client || !channelId) return;
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel) return;
  try {
    const embed = buildDmInteractionEmbed(interaction, kind);
    await channel.send({ embeds: [embed] });
  } catch (err) {
    log.warn({ err, userId: interaction.user?.id, customId: interaction.customId }, 'Failed to send DM interaction log embed');
  }
}

async function buildUnmatchedDmEmbed(message) {
  const user = message.author;
  const attachments = [...message.attachments.values()];
  const attachmentSummary = attachments.length === 0
    ? null
    : `${attachments.length} (${attachments.map(a => a.contentType || a.name || 'file').join(', ').slice(0, 200)})`;

  let memberSince = null;
  try {
    const guild = await client.guilds.fetch(config.guild.id).catch(() => null);
    const member = guild ? await guild.members.fetch(user.id).catch(() => null) : null;
    if (member?.joinedTimestamp) memberSince = `<t:${Math.floor(member.joinedTimestamp / 1000)}:R>`;
  } catch {}

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setAuthor({ name: `DM from ${user.tag}`, iconURL: user.displayAvatarURL() })
    .setFooter({ text: 'Royal Secretary - DM log' })
    .setTimestamp();

  const fields = [
    { name: 'User', value: `<@${user.id}> \`${user.id}\``, inline: false },
    { name: 'Account created', value: `<t:${Math.floor(user.createdTimestamp / 1000)}:R>`, inline: true },
    { name: 'In guild', value: memberSince ? `Yes - joined ${memberSince}` : 'No / unknown', inline: true },
    { name: 'Routed to', value: 'Welcome menu (no open ticket/prospect)', inline: false },
  ];

  if (message.content) {
    const quoted = message.content.split('\n').map(l => `> ${l}`).join('\n');
    fields.push({ name: 'Message', value: truncate(quoted, 1800), inline: false });
  }
  if (attachmentSummary) fields.push({ name: 'Attachments', value: attachmentSummary, inline: false });

  embed.addFields(fields);
  return embed;
}

function buildDmInteractionEmbed(interaction, kind) {
  const user = interaction.user;
  const action = kind === 'button'
    ? `Clicked button: \`${interaction.customId}\``
    : kind === 'modal'
      ? `Submitted modal: \`${interaction.customId}\``
      : kind === 'select'
        ? `Selected option: \`${interaction.customId}\``
        : `Interaction: \`${interaction.customId || 'unknown'}\``;

  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setAuthor({ name: `DM interaction from ${user.tag}`, iconURL: user.displayAvatarURL() })
    .addFields(
      { name: 'User', value: `<@${user.id}> \`${user.id}\``, inline: false },
      { name: 'Action', value: action, inline: false },
    )
    .setFooter({ text: 'Royal Secretary - DM log' })
    .setTimestamp();
}

function truncate(str, max) {
  if (!str) return '';
  const s = String(str);
  return s.length <= max ? s : s.slice(0, max - 3) + '...';
}
