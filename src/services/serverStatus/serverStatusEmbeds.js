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

function getStatusIndicator(playerCount, seedThreshold, connected) {
  if (!connected) return { text: 'Disconnected from server', icon: ':black_circle:' };
  if (playerCount >= seedThreshold) return { text: 'LIVE', icon: ':green_circle:' };
  if (playerCount > 0) return { text: 'We are seeding - join us!', icon: ':yellow_circle:' };
  return { text: 'Server is empty', icon: ':red_circle:' };
}

function formatPlayerList(players, rbSteamIds) {
  if (!players.length) return '*No players*';

  const sorted = [...players].sort((a, b) => {
    const nameA = a.name || 'Unknown';
    const nameB = b.name || 'Unknown';
    const aRB = rbSteamIds.has(a.steamID);
    const bRB = rbSteamIds.has(b.steamID);
    if (aRB !== bRB) return aRB ? -1 : 1;
    return nameA.localeCompare(nameB, undefined, { sensitivity: 'base' });
  });

  const names = sorted.map((p) => {
    const name = p.name || 'Unknown';
    return rbSteamIds.has(p.steamID) ? `**${name}**` : name;
  });

  const joined = names.join('\n');
  // Discord field value limit is 1024 chars
  if (joined.length > 1000) {
    const truncated = [];
    let len = 0;
    for (const name of names) {
      if (len + name.length + 1 > 950) {
        truncated.push(`*... and ${names.length - truncated.length} more*`);
        break;
      }
      truncated.push(name);
      len += name.length + 1;
    }
    return truncated.join('\n');
  }
  return joined;
}

function getFactionFromPlayers(players, teamID) {
  const player = players.find((p) => p.teamID === teamID && p.squad?.teamName);
  return player?.squad?.teamName || null;
}

function getTeamFaction(layerObj, teamIndex, players) {
  if (layerObj?.teams?.[teamIndex]) return layerObj.teams[teamIndex].faction;
  return getFactionFromPlayers(players, teamIndex + 1);
}

function getMatchupTeams(layerObj, players) {
  const hasLayerTeams = layerObj?.teams?.length >= 2;
  const faction1 = hasLayerTeams ? null : getFactionFromPlayers(players, 1);
  const faction2 = hasLayerTeams ? null : getFactionFromPlayers(players, 2);

  if (hasLayerTeams) {
    const t1 = layerObj.teams[0];
    const t2 = layerObj.teams[1];
    const fmt = (t) => {
      const short = t.shortName;
      const full = t.name || t.faction;
      if (short && full) return `**${short}**\n${full}`;
      return full || short || 'Unknown';
    };
    return { team1: fmt(t1), team2: fmt(t2) };
  }

  if (faction1 || faction2) {
    return { team1: `**${faction1 || 'Team 1'}**`, team2: `**${faction2 || 'Team 2'}**` };
  }

  return null;
}

function getLayerImageUrl(layerObj, layerName) {
  const BASE = 'https://raw.githubusercontent.com/Squad-Wiki/squad-wiki-pipeline-map-data/master/completed_output/_Current%20Version/images';
  if (layerObj?.layerid) return `${BASE}/${layerObj.layerid}.jpg`;
  // Fallback: construct from layer name string (e.g. "BlackCoast Seed v1" -> "BlackCoast_Seed_v1")
  if (layerName) return `${BASE}/${layerName.replace(/\s+/g, '_')}.jpg`;
  return null;
}

export function buildServerStatusEmbed(state, seedThreshold = 40, rbSteamIds = new Set()) {
  const totalSlots = state.publicSlots + state.reserveSlots;
  const color = getStatusColor(state.playerCount, totalSlots);
  const status = getStatusIndicator(state.playerCount, seedThreshold, state.connected);

  const embed = createEmbed('Server Status')
    .setColor(color);

  // Title with server name
  if (state.serverName) {
    embed.setTitle(`${status.icon} \u00AD \u00AD${state.serverName}`);
  } else {
    embed.setTitle(`${status.icon} \u00AD \u00ADServer Status`);
  }

  // Player count
  let playerStr = `${state.playerCount}`;
  playerStr += ` / ${state.publicSlots || '?'}`;

  embed.addFields(
    { name: 'Players', value: playerStr, inline: true },
    { name: 'Queue', value: String(state.publicQueue + state.reserveQueue), inline: true },
    { name: '\u200b', value: status.text, inline: false },
  );

  // Layer + Server version
  if (state.gameVersion) {
    const version = state.gameVersion.replace(/^v/, '').split('.').slice(0, 3).join('.');
    embed.addFields(
      { name: 'Layer', value: state.currentLayer || 'Unknown', inline: true },
      { name: 'Server version', value: `v${version}`, inline: true },
    );
  } else {
    embed.addFields({
      name: 'Layer',
      value: state.currentLayer || 'Unknown',
      inline: false,
    });
  }

  // Matchup
  const matchup = getMatchupTeams(state.currentLayerObj, state.players);
  if (matchup) {
    embed.addFields(
      { name: '\u200b', value: matchup.team1, inline: true },
      { name: 'Matchup', value: 'vs', inline: true },
      { name: '\u200b', value: matchup.team2, inline: true },
    );
  }

  // Team player lists
  const team1Players = state.players.filter((p) => p.teamID === 1);
  const team2Players = state.players.filter((p) => p.teamID === 2);
  const faction1 = getTeamFaction(state.currentLayerObj, 0, state.players) || 'Team 1';
  const faction2 = getTeamFaction(state.currentLayerObj, 1, state.players) || 'Team 2';

  embed.addFields(
    {
      name: `Team 1 \u2022 ${team1Players.length} players \u2022 ${faction1}`,
      value: formatPlayerList(team1Players, rbSteamIds),
      inline: true,
    },
    {
      name: `Team 2 \u2022 ${team2Players.length} players \u2022 ${faction2}`,
      value: formatPlayerList(team2Players, rbSteamIds),
      inline: true,
    },
  );

  // BattleMetrics link
  const bmServerId = config.battlemetrics?.serverId;
  if (bmServerId) {
    embed.addFields({
      name: 'BattleMetrics',
      value: `[View Server Statistics](https://www.battlemetrics.com/servers/squad/${bmServerId})`,
      inline: false,
    });
  }

  // Last updated
  const now = Math.floor(Date.now() / 1000);
  embed.addFields({ name: '\u200b', value: `Last updated <t:${now}:R>`, inline: false });

  // Layer map image
  const imageUrl = getLayerImageUrl(state.currentLayerObj, state.currentLayer);
  if (imageUrl) {
    embed.setImage(imageUrl);
  }

  return embed;
}
