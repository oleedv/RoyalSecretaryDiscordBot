import tinygradient from 'tinygradient';
import { createEmbed } from '../../utils/embed.js';
import config from '../../config.js';

const gradient = tinygradient([
  { color: '#ff0000', pos: 0 },
  { color: '#ffff00', pos: 0.5 },
  { color: '#00ff00', pos: 1 },
]);

function getStatusColor(playerCount, totalSlots) {
  const ratio = Math.min(1, Math.max(0, playerCount / (totalSlots || 1)));
  return parseInt(gradient.rgbAt(ratio).toHex(), 16);
}

function getTpsColor(avgTps) {
  if (avgTps >= 45) return '🟢';
  if (avgTps >= 40) return '🟡';
  if (avgTps >= 35) return '🟠';
  return '🔴';
}

function getPopColor(playerCount, totalSlots) {
  if (!totalSlots) return '⚪';
  const ratio = playerCount / totalSlots;
  if (ratio >= 0.95) return '🟢';
  if (ratio >= 0.55) return '🟡';
  if (ratio > 0) return '🟠';
  return '🔴';
}

function getQueueColor(queue) {
  if (queue >= 15) return '🔴';
  if (queue >= 6) return '🟡';
  if (queue > 0) return '🟢';
  return '🟢';
}

function getStatusIndicator(playerCount, seedThreshold, connected) {
  if (!connected) return { text: 'Disconnected from server', icon: '⚫' };
  if (playerCount >= seedThreshold) return { text: '**LIVE**', icon: '🟢' };
  if (playerCount > 0) return { text: '**We are seeding — join us!**', icon: '🟡' };
  return { text: '**Server is empty**', icon: '🔴' };
}

function formatDurationFromUnix(unixTs) {
  if (unixTs == null) return null;
  const secs = Math.max(0, Math.floor(Date.now() / 1000) - Number(unixTs));
  const hours = Math.floor(secs / 3600);
  const minutes = Math.floor((secs % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function getFactionFromPlayers(players, teamID) {
  const player = players.find((p) => p.teamID === teamID && p.squad?.teamName);
  return player?.squad?.teamName || null;
}

function getMatchupTeams(layerObj, players) {
  const hasLayerTeams = layerObj?.teams?.length >= 2;

  if (hasLayerTeams) {
    const t1 = layerObj.teams[0];
    const t2 = layerObj.teams[1];
    const fmt = (t) => {
      const short = t.shortName;
      const full = t.name || t.faction;
      if (short && full && short !== full) return { short, full };
      return { short: full || short || 'Unknown', full: null };
    };
    return { team1: fmt(t1), team2: fmt(t2) };
  }

  const faction1 = getFactionFromPlayers(players, 1);
  const faction2 = getFactionFromPlayers(players, 2);
  if (faction1 || faction2) {
    return {
      team1: { short: faction1 || 'Team 1', full: null },
      team2: { short: faction2 || 'Team 2', full: null },
    };
  }
  return null;
}

function formatTeamField(team) {
  if (!team) return 'Unknown';
  if (team.full) return `**${team.short}**\n${team.full}`;
  return `**${team.short}**`;
}

function formatAdminList(adminsOnline) {
  if (!adminsOnline.length) return '*None online*';

  const lines = adminsOnline.map((a) => {
    const team = a.teamID === 1 ? 'T1' : a.teamID === 2 ? 'T2' : null;
    const bits = [a.role, team].filter(Boolean).join(' · ');
    return bits ? `· **${a.name}** · ${bits}` : `· **${a.name}**`;
  });

  const joined = lines.join('\n');
  if (joined.length <= 1000) return joined;

  const truncated = [];
  let len = 0;
  for (const line of lines) {
    if (len + line.length + 1 > 950) {
      truncated.push(`*... and ${lines.length - truncated.length} more*`);
      break;
    }
    truncated.push(line);
    len += line.length + 1;
  }
  return truncated.join('\n');
}

/**
 * Build the quick-status embed (stats only; admin names, no full roster).
 *
 * @param {object} state - SquadJS connection state
 * @param {number} seedThreshold
 * @param {object} roles - from classifyOnlinePlayers
 * @param {object} serverStats - from getServerStats
 * @param {{ voiceCount?: number }} [extras]
 */
export function buildQuickStatusEmbed(state, seedThreshold = 40, roles = {}, serverStats = {}, extras = {}) {
  const totalSlots = (state.publicSlots || 0) + (state.reserveSlots || 0);
  const publicSlots = state.publicSlots || 0;
  const playerCount = state.playerCount ?? 0;
  const queue = (state.publicQueue || 0) + (state.reserveQueue || 0);
  const color = getStatusColor(playerCount, publicSlots || totalSlots || 1);
  const status = getStatusIndicator(playerCount, seedThreshold, state.connected);

  const titleName = state.serverName || 'Server Status';
  const embed = createEmbed('Quick Status')
    .setColor(color)
    .setTitle(`${status.icon}  ${titleName}`)
    .setDescription(`Updated <t:${Math.floor(Date.now() / 1000)}:R> · ${status.text}`);

  const popColor = getPopColor(playerCount, publicSlots || totalSlots || 1);
  const queueColor = getQueueColor(queue);
  const onlineStr = publicSlots
    ? `${popColor} **${playerCount}** / ${publicSlots}${state.reserveSlots ? ` · ${state.reserveSlots} res` : ''}`
    : `${popColor} **${playerCount}**`;
  const voiceCount = extras.voiceCount;
  const voiceStr = voiceCount != null ? `💬 **${voiceCount}**` : '💬 **—**';

  embed.addFields(
    { name: 'Online', value: onlineStr, inline: true },
    { name: 'Queue', value: `${queueColor} **${queue}**`, inline: true },
    { name: 'In Voice', value: voiceStr, inline: true },
  );

  const rb = roles.rbCount ?? 0;
  const prospects = roles.prospectCount ?? 0;
  const wl = roles.wlCount ?? 0;
  const admins = roles.adminCount ?? 0;
  const t1rb = roles.teamOneRBs ?? 0;
  const t2rb = roles.teamTwoRBs ?? 0;
  const rbSplit = rb > 0 ? ` (${t1rb}v${t2rb})` : '';

  embed.addFields(
    { name: 'RB Members', value: `💖 **${rb}**${rbSplit}`, inline: true },
    { name: 'Prospects', value: `💝 **${prospects}**`, inline: true },
    { name: 'WL / Admins', value: `🤍 **${wl}** / 🔨 **${admins}**`, inline: true },
  );

  // Layer + version
  const layer = state.currentLayer || 'Unknown';
  if (state.gameVersion) {
    const version = String(state.gameVersion).replace(/^v/, '').split('.').slice(0, 3).join('.');
    embed.addFields({ name: 'Layer', value: `${layer} · v${version}`, inline: false });
  } else {
    embed.addFields({ name: 'Layer', value: layer, inline: false });
  }

  const matchup = getMatchupTeams(state.currentLayerObj, state.players || []);
  if (matchup) {
    embed.addFields(
      { name: 'Team 1', value: formatTeamField(matchup.team1), inline: true },
      { name: 'Matchup', value: 'vs', inline: true },
      { name: 'Team 2', value: formatTeamField(matchup.team2), inline: true },
    );
  }

  const duration = formatDurationFromUnix(serverStats.matchStartTime);
  const matchField = duration
    ? { name: 'Match started', value: `⏱️ **${duration}** ago`, inline: true }
    : null;

  const tpsField = serverStats.avgTps != null
    ? {
      name: 'TPS (10m)',
      value: `${getTpsColor(serverStats.avgTps)} **${serverStats.avgTps}** (${serverStats.minTps}–${serverStats.maxTps})`,
      inline: true,
    }
    : null;

  const newPlayers = serverStats.newPlayers1h ?? 0;
  const newField = newPlayers > 0
    ? { name: 'New players (1h)', value: `🆕 **${newPlayers}**`, inline: true }
    : null;

  const statsRow = [matchField, tpsField, newField].filter(Boolean);
  if (statsRow.length) embed.addFields(...statsRow);

  const t1 = roles.teamOneSize ?? 0;
  const t2 = roles.teamTwoSize ?? 0;
  if (playerCount > 0 && (t1 > 0 || t2 > 0)) {
    embed.addFields({ name: 'Team sizes', value: `**${t1}** vs **${t2}**`, inline: true });
  }

  const bmServerId = config.battlemetrics?.serverId;
  if (bmServerId) {
    embed.addFields({
      name: 'BattleMetrics',
      value: `[View server statistics](https://www.battlemetrics.com/servers/squad/${bmServerId})`,
      inline: true,
    });
  }

  const adminList = roles.adminsOnline || [];
  embed.addFields({
    name: `Admins online (${adminList.length})`,
    value: formatAdminList(adminList),
    inline: false,
  });

  embed.setFooter({ text: 'Royal Secretary · refreshes every 60s' });

  return embed;
}

/**
 * Second embed: RB members / prospects in-game but not in Discord voice.
 * Mirrors the old Python "Not on Discord while playing" widget.
 *
 * @param {Array<{ name: string, discordId?: string|null, steamId?: string|null, kind?: string }>} missing
 * @param {{ isSeeding?: boolean }} [opts]
 */
export function buildMissingDiscordEmbed(missing = [], opts = {}) {
  const embed = createEmbed('Quick Status')
    .setTitle('Not on Discord while playing');

  if (!missing.length) {
    return embed
      .setColor(0x57f287)
      .setDescription('Everyone accounted for.');
  }

  const lines = missing.map((p) => {
    const steam = p.steamId
      ? `[Steam](https://www.steamid.com/profiles/${p.steamId})`
      : null;
    const tag = p.kind === 'prospect' ? ' [Prospect]' : p.kind === 'member' ? ' [Member]' : '';
    if (p.discordId && steam) return `· <@${p.discordId}>${tag} — ${steam}`;
    if (p.discordId) return `· <@${p.discordId}>${tag}`;
    if (steam) return `· **${p.name || 'Unknown'}**${tag} — ${steam}`;
    return `· **${p.name || 'Unknown'}**${tag}`;
  });

  let description = lines.join('\n');
  if (description.length > 4000) {
    const kept = [];
    let len = 0;
    for (const line of lines) {
      if (len + line.length + 1 > 3900) {
        kept.push(`*... and ${lines.length - kept.length} more*`);
        break;
      }
      kept.push(line);
      len += line.length + 1;
    }
    description = kept.join('\n');
  }

  embed.setColor(0xfee75c).setDescription(description);

  if (opts.isSeeding) {
    embed.setFooter({ text: 'Seeding — voice not required for prospects' });
  } else {
    embed.setFooter({ text: 'In-game but not in Discord voice' });
  }

  return embed;
}
