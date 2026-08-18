/**
 * Classify online players against website WhitelistEntry + AdminGroup.
 *
 * A group is an admin group when its website permissions include kick or ban
 * (same rule as the whitelist panel). Role-name fallback is only used when
 * no permission string / group list is available.
 *
 * RB Members: Member
 * Prospects: Prospect
 * WL: any other active whitelist role (Whitelist, Seeder, clan partners, etc.)
 */

export const ADMIN_ROLES = Object.freeze([
  'TraineeAdmin',
  'Admin',
  'SeniorAdmin',
  'SuperAdmin',
  'Founder',
]);

const ADMIN_ROLE_SET = new Set(ADMIN_ROLES.map((r) => r.toLowerCase().replace(/[\s_-]+/g, '')));

export function normalizeRole(role) {
  return String(role || '').trim();
}

/** Compare roles ignoring case and spaces (SeniorAdmin === "Senior Admin"). */
function roleKey(role) {
  return normalizeRole(role).toLowerCase().replace(/[\s_-]+/g, '');
}

/** Website AdminGroup.permissions is a comma-separated Squad permission list. */
export function groupHasKickOrBan(permissions) {
  const parts = String(permissions || '')
    .split(',')
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  return parts.includes('kick') || parts.includes('ban');
}

export function adminGroupNameKeys(groups = []) {
  const names = new Set();
  for (const g of groups) {
    if (!groupHasKickOrBan(g?.permissions)) continue;
    const key = roleKey(g.name);
    if (key) names.add(key);
  }
  return names;
}

export function isAdminRole(role, adminNames = null) {
  if (adminNames && adminNames.size > 0) return adminNames.has(roleKey(role));
  return ADMIN_ROLE_SET.has(roleKey(role));
}

export function isMemberRole(role) {
  return roleKey(role) === 'member';
}

export function isProspectRole(role) {
  return roleKey(role) === 'prospect';
}

/**
 * Prefer the highest-privilege entry when a steamId has multiple active rows.
 * admin > member > prospect > wl
 */
export function pickPrimaryEntry(entries) {
  if (!entries?.length) return null;
  const rank = (role) => {
    if (isAdminRole(role)) return 4;
    if (isMemberRole(role)) return 3;
    if (isProspectRole(role)) return 2;
    if (normalizeRole(role)) return 1;
    return 0;
  };
  return [...entries].sort((a, b) => rank(b.role) - rank(a.role))[0];
}

/**
 * Labels used for classification. AdminGroup.name is what admins.cfg uses;
 * WhitelistEntry.role is a legacy/display field and can be Member/Whitelist
 * even when the linked group is SuperAdmin.
 */
export function roleLabelsFromEntry(entry) {
  const labels = [];
  const seen = new Set();
  for (const raw of [entry?.role, entry?.groupName]) {
    const role = normalizeRole(raw);
    const key = roleKey(role);
    if (!role || seen.has(key)) continue;
    seen.add(key);
    labels.push(role);
  }
  return labels;
}

/**
 * @param {Array<{ steamID?: string, steamId?: string, name?: string, teamID?: number }>} players
 * @param {Map<string, Array<{ role?: string, groupName?: string, groupPermissions?: string, name?: string }>>} entriesBySteamId
 * @param {Array<{ name?: string, permissions?: string, sortOrder?: number }>} [adminGroups]
 */
export function classifyOnlinePlayers(players, entriesBySteamId, adminGroups = []) {
  const adminNames = adminGroupNameKeys(adminGroups);
  const orderByName = new Map(
    (adminGroups || [])
      .filter((g) => groupHasKickOrBan(g?.permissions))
      .map((g) => [roleKey(g.name), Number(g.sortOrder) || 0]),
  );
  const result = {
    rbCount: 0,
    prospectCount: 0,
    wlCount: 0,
    adminCount: 0,
    teamOneRBs: 0,
    teamTwoRBs: 0,
    teamOneSize: 0,
    teamTwoSize: 0,
    adminsOnline: [], // { name, role, teamID }
  };

  for (const p of players || []) {
    const teamID = p.teamID != null ? Number(p.teamID) : null;
    if (teamID === 1) result.teamOneSize++;
    else if (teamID === 2) result.teamTwoSize++;

    const steamId = String(p.steamID || p.steamId || '');
    if (!steamId) continue;

    const entries = entriesBySteamId.get(steamId) || [];
    if (!entries.length) continue;

    // Counts can stack if a player has multiple active rows (e.g. Member + Admin).
    let isAdmin = false;
    let isMember = false;
    let isProspect = false;
    let isWlOnly = false;
    let adminRole = null;
    let adminRank = -1;

    for (const entry of entries) {
      const labels = roleLabelsFromEntry(entry);
      const permsKnown = entry.groupPermissions != null;
      const entryIsAdmin = permsKnown
        ? groupHasKickOrBan(entry.groupPermissions)
        : labels.some((role) => isAdminRole(role, adminNames.size ? adminNames : null));

      if (entryIsAdmin) {
        isAdmin = true;
        const title = entry.groupName || labels.find((r) => isAdminRole(r, adminNames.size ? adminNames : null)) || labels[0] || 'Admin';
        const rank = ADMIN_ROLES.findIndex((r) => roleKey(r) === roleKey(title));
        const sort = orderByName.has(roleKey(title))
          ? 1000 + orderByName.get(roleKey(title))
          : (rank >= 0 ? rank : 99);
        if (sort >= adminRank) {
          adminRank = sort;
          adminRole = rank >= 0 ? ADMIN_ROLES[rank] : title;
        }
      }

      for (const role of labels) {
        if (isMemberRole(role)) isMember = true;
        else if (isProspectRole(role)) isProspect = true;
        else if (!entryIsAdmin && !isAdminRole(role, adminNames.size ? adminNames : null)) isWlOnly = true;
      }
    }

    const displayName = p.name || entries[0]?.name || 'Unknown';

    if (isAdmin) {
      result.adminCount++;
      result.adminsOnline.push({
        name: displayName,
        role: adminRole || 'Admin',
        teamID,
      });
    }
    if (isMember) {
      result.rbCount++;
      if (teamID === 1) result.teamOneRBs++;
      else if (teamID === 2) result.teamTwoRBs++;
    }
    if (isProspect) result.prospectCount++;
    // Exclusive WL bucket for the compact row (partner/clan/seeder, not RB/prospect/admin)
    if (isWlOnly && !isAdmin && !isMember && !isProspect) result.wlCount++;
  }

  // Stable sort: by role rank then name
  const roleOrder = Object.fromEntries(ADMIN_ROLES.map((r, i) => [roleKey(r), i]));
  result.adminsOnline.sort((a, b) => {
    const ra = roleOrder[roleKey(a.role)] ?? 99;
    const rb = roleOrder[roleKey(b.role)] ?? 99;
    if (ra !== rb) return ra - rb;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });

  return result;
}
