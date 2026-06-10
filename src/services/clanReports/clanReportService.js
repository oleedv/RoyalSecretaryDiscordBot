// Orchestrator: takes a request (clanId, serverId, window, panel) and returns
// { filename, content, summary } for the .txt artifact + the short channel message.
//
// The service collects all data needed for: the metadata header, the shared
// KPI block, the requested panel body, and the tag-spotters count (shown in KPI).

import { AttachmentBuilder } from 'discord.js';
import config from '../../config.js';
import logger from '../../logger.js';
import * as q from './clanReportQueries.js';
import * as f from './clanReportFormatters.js';
import { getPanel, getWindow } from './panelRegistry.js';

const log = logger.child({ module: 'clanReports:service' });

const BOT_VERSION = '2.4.0';

function timestampSlug() {
  const d = new Date();
  const Y = d.getUTCFullYear();
  const M = String(d.getUTCMonth() + 1).padStart(2, '0');
  const D = String(d.getUTCDate()).padStart(2, '0');
  const h = String(d.getUTCHours()).padStart(2, '0');
  const m = String(d.getUTCMinutes()).padStart(2, '0');
  const s = String(d.getUTCSeconds()).padStart(2, '0');
  return `${Y}${M}${D}_${h}${m}${s}`;
}

function sanitizeTag(tag) {
  return String(tag || 'clan').replace(/[^A-Za-z0-9_-]/g, '_');
}

async function computeKpi({ clan, members, serverId, days, steamIds }) {
  const [
    activity,
    combat,
    matchOutcomes,
    expiringSoon,
    lastActivity,
    tagSpottersCount,
  ] = await Promise.all([
    q.getActivityRows(steamIds, serverId, days),
    q.getCombatRows(steamIds, serverId, days),
    q.getMatchOutcomes(steamIds, serverId, days),
    q.countExpiringSoon(clan.id),
    q.getLastClanActivity(steamIds, serverId),
    q.countTagSpotters(clan.tag, steamIds),
  ]);

  let totalSessionSeconds = 0;
  let totalSeedSeconds = 0;
  for (const r of activity) {
    totalSessionSeconds += Number(r.totalSeconds || 0);
    totalSeedSeconds += Number(r.seedSeconds || 0);
  }

  let kills = 0, deaths = 0;
  for (const r of combat) {
    kills += Number(r.kills || 0);
    deaths += Number(r.deaths || 0);
  }

  // Win attribution: reuse the same logic as formatMatches by reading match rows
  let wins = 0, matchesCounted = 0;
  for (const m of matchOutcomes.matches) {
    const teamIds = String(m.clanTeamIds || '').split(',').filter(Boolean).map(Number);
    let a = 0, b = 0;
    for (const t of teamIds) { if (t === 1) a++; else if (t === 2) b++; }
    let clanTeam = null;
    if (a > b) clanTeam = 1;
    else if (b > a) clanTeam = 2;
    let winnerTeam = null;
    if (m.winner) {
      try {
        const parsed = typeof m.winner === 'string' ? JSON.parse(m.winner) : m.winner;
        if (parsed && (parsed.team_id || parsed.team)) {
          winnerTeam = Number(parsed.team_id || parsed.team);
        }
      } catch { /* ignore */ }
    }
    if (clanTeam !== null && winnerTeam !== null) {
      matchesCounted++;
      if (clanTeam === winnerTeam) wins++;
    }
  }

  return {
    activeMembers: members.length,
    expiringSoon,
    totalSessionSeconds,
    totalSeedSeconds,
    kills,
    deaths,
    wins,
    matchesCounted,
    lastActivity,
    tagSpottersCount,
  };
}

export async function generateReport({ clanId, serverId, window, panel, generatedBy }) {
  const startMs = Date.now();
  const panelDef = getPanel(panel);
  const winDef = getWindow(window);
  if (!panelDef) throw new Error(`Unknown panel: ${panel}`);

  const [clan, server] = await Promise.all([q.getClan(clanId), q.getServer(serverId)]);
  if (!clan) throw new Error('Clan not found.');
  if (!server) throw new Error('Server not found.');

  const members = await q.getClanMembers(clanId);
  const steamIds = members.map((m) => m.steamId).filter(Boolean);
  const days = winDef.days;

  // Always-needed bits
  const [kpi, lastSeenMap] = await Promise.all([
    computeKpi({ clan, members, serverId, days, steamIds }),
    q.getLastSeenForSteamIds(steamIds),
  ]);

  // Panel body
  let body;
  if (panel === 'overview') {
    const tagSpotters = await q.getTagSpotters(clan.tag, serverId, steamIds);
    body = f.formatOverview({ tagSpotters, clan, windowId: window });
  } else if (panel === 'activity') {
    const rows = await q.getActivityRows(steamIds, serverId, days);
    body = f.formatActivity({ rows, members, lastSeenMap });
  } else if (panel === 'seeding') {
    const [rows, milestoneTarget] = [
      await q.getSeedingRows(steamIds, serverId, days),
      config.seedTracker?.requiredSeedDays || null,
    ];
    body = f.formatSeeding({ rows, members, milestoneTarget });
  } else if (panel === 'roster') {
    body = f.formatRoster({ members, lastSeenMap });
  } else if (panel === 'combat') {
    const rows = await q.getCombatRows(steamIds, serverId, days);
    body = f.formatCombat({ rows, members });
  } else if (panel === 'matches') {
    const { perMember, matches } = await q.getMatchOutcomes(steamIds, serverId, days);
    body = f.formatMatches({ perMember, matches });
  } else if (panel === 'heatmap') {
    const { hours, dows } = await q.getHourBuckets(steamIds, serverId, days);
    body = f.formatHeatmap({ hours, dows });
  } else if (panel === 'growth') {
    const [newMembers, expired] = await Promise.all([
      q.getNewMembers(clanId, days),
      q.getExpiredOrRemoved(clanId, days),
    ]);
    // Inactive >30d: active members whose last_seen is null or older than 30 days
    const cutoff = Date.now() - 30 * 86400000;
    const inactive = members
      .map((m) => {
        const ls = lastSeenMap.get(m.steamId);
        const lastSeen = ls?.lastSeen || null;
        return { name: m.name || ls?.name || null, steamId: m.steamId, lastSeen };
      })
      .filter((r) => !r.lastSeen || new Date(r.lastSeen).getTime() < cutoff)
      .sort((a, b) => {
        if (!a.lastSeen && !b.lastSeen) return 0;
        if (!a.lastSeen) return 1;
        if (!b.lastSeen) return -1;
        return new Date(a.lastSeen).getTime() - new Date(b.lastSeen).getTime();
      });
    body = f.formatGrowth({ newMembers, expired, inactive, windowId: window });
  } else {
    throw new Error(`Unsupported panel: ${panel}`);
  }

  const header = f.buildMetadataHeader({
    panel,
    panelLabel: panelDef.label,
    clan,
    server,
    window,
    generatedBy,
    botVersion: BOT_VERSION,
  });
  const kpiBlock = f.buildKpiBlock(kpi, clan.tag, window);
  const content = header + kpiBlock + body;

  const filename = `${sanitizeTag(clan.tag)}_${panel}_${timestampSlug()}.txt`;
  const attachment = new AttachmentBuilder(Buffer.from(content, 'utf8'), { name: filename });

  const summary = `${panelDef.label} report for [${clan.tag}] ${clan.name} (${winDef.label}) generated by <@${generatedBy.id}>.`;

  log.info({
    clanId,
    serverId,
    panel,
    window,
    members: members.length,
    fileBytes: Buffer.byteLength(content, 'utf8'),
    durationMs: Date.now() - startMs,
    userId: generatedBy.id,
  }, 'clan report generated');

  return { filename, content, summary, attachment };
}
