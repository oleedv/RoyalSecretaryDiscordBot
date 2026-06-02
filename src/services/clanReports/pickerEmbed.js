// Picker embed + components.
//
// State is encoded into select-menu and button customIds — stateless across restarts.
// Layout (5 rows max):
//   Row 1: clan dropdown        cr_clan_select:<serverId|none>
//   Row 2: server dropdown      cr_server_select:<clanId|none>
//   Row 3: time-window buttons  cr_window:<clanId>:<serverId>:<window>   (shown only when both selections present)
//   Row 4: panel buttons (top)  cr_panel:<panel>:<clanId>:<serverId>:<window>
//   Row 5: panel buttons (bot)  cr_panel:<panel>:<clanId>:<serverId>:<window>

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  EmbedBuilder,
} from 'discord.js';
import { PANELS, WINDOWS } from './panelRegistry.js';
import { listClans, listServers } from './clanReportQueries.js';

const COLOR = 0xebc65d;

function clanDropdown(clans, selectedClanId, serverId) {
  const opts = clans.slice(0, 25).map((c) => ({
    label: `[${c.tag}] ${c.name}`.slice(0, 100),
    value: c.id,
    default: selectedClanId === c.id,
  }));
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`cr_clan_select:${serverId || 'none'}`)
    .setPlaceholder('Pick a clan...')
    .setMinValues(1)
    .setMaxValues(1);
  if (opts.length > 0) menu.addOptions(opts);
  else menu.setPlaceholder('No clans configured').addOptions([{ label: 'No clans', value: 'noop' }]).setDisabled(true);
  return new ActionRowBuilder().addComponents(menu);
}

function serverDropdown(servers, selectedServerId, clanId) {
  const sel = selectedServerId != null ? String(selectedServerId) : null;
  const opts = servers.slice(0, 25).map((s) => ({
    label: s.name,
    value: String(s.id),
    default: sel === String(s.id),
  }));
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`cr_server_select:${clanId || 'none'}`)
    .setPlaceholder('Pick a server...')
    .setMinValues(1)
    .setMaxValues(1);
  if (opts.length > 0) menu.addOptions(opts);
  else menu.setPlaceholder('No servers configured').addOptions([{ label: 'No servers', value: 'noop' }]).setDisabled(true);
  return new ActionRowBuilder().addComponents(menu);
}

function windowRow(clanId, serverId, window) {
  const row = new ActionRowBuilder();
  for (const w of WINDOWS) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`cr_window:${clanId}:${serverId}:${w.id}`)
        .setLabel(w.label)
        .setStyle(w.id === window ? ButtonStyle.Primary : ButtonStyle.Secondary)
    );
  }
  return row;
}

function panelRow(rowKind, clanId, serverId, window) {
  const row = new ActionRowBuilder();
  for (const p of PANELS.filter((p) => p.row === rowKind)) {
    const btn = new ButtonBuilder()
      .setCustomId(`cr_panel:${p.id}:${clanId}:${serverId}:${window}`)
      .setStyle(ButtonStyle.Secondary)
      .setEmoji({ name: p.emoji });
    // Top row: emoji-only. Bottom row: emoji + label.
    if (rowKind === 'bottom') btn.setLabel(p.label);
    row.addComponents(btn);
  }
  return row;
}

function buildLegend() {
  // Plain-text legend (no glyphs in source) — but rendered as actual emoji
  // because the panel registry holds the codepoint strings.
  return PANELS.map((p) => `${p.emoji} ${p.label}`).join('  ·  ');
}

function buildEmbed({ clan, server, window }) {
  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle('Clan Report')
    .setFooter({ text: 'Royal Battalion ● Clan Reports' })
    .setTimestamp();

  if (!clan && !server) {
    embed.setDescription('Pick a clan and a server to begin.');
    return embed;
  }
  if (!clan) {
    embed.setDescription(`Server selected: **${server.name}**.\nPick a clan to continue.`);
    return embed;
  }
  if (!server) {
    embed.setDescription(`Clan selected: **[${clan.tag}] ${clan.name}**.\nPick a server to continue.`);
    return embed;
  }
  // Both selected: show legend + window note
  embed.setDescription(
    `**[${clan.tag}] ${clan.name}** on **${server.name}** — window **${WINDOWS.find((w) => w.id === window)?.label || window}**\n\nPick a panel to generate a .txt report:\n${buildLegend()}`
  );
  return embed;
}

export async function buildPickerView({ clanId, serverId, window, clan, server }) {
  // Fetch options
  const [clans, servers] = await Promise.all([listClans(), listServers()]);

  // Resolve clan/server names if only ids were passed
  let resolvedClan = clan || null;
  if (!resolvedClan && clanId) {
    resolvedClan = clans.find((c) => c.id === clanId) || null;
  }
  let resolvedServer = server || null;
  if (!resolvedServer && serverId != null) {
    resolvedServer = servers.find((s) => String(s.id) === String(serverId)) || null;
  }

  const embed = buildEmbed({ clan: resolvedClan, server: resolvedServer, window });
  const rows = [
    clanDropdown(clans, clanId || null, serverId || null),
    serverDropdown(servers, serverId != null ? serverId : null, clanId || null),
  ];

  if (clanId && serverId != null) {
    rows.push(windowRow(clanId, serverId, window));
    rows.push(panelRow('top', clanId, serverId, window));
    rows.push(panelRow('bottom', clanId, serverId, window));
  }

  return { embed, components: rows };
}
