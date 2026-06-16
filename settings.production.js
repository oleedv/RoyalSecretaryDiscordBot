// Production environment settings (live Discord server)
// Secrets (tokens, DB credentials) belong in GitHub Secrets — not here.
// TODO: Replace all IDs below with production Discord server values.

export default {
  bot: {
    name: 'Royal Secretary',
    version: '1.0.0',
  },
  webBaseUrl: 'https://royalbattalion.xyz',
  guild: {
    id: '458272992892420108',                           // Production guild ID
  },
  channels: {},
  roles: {},
  tickets: {
    categoryId: '751826729928097922',                   // Ticket category
    panelChannelId: '1476956038975455423',               // "Create Ticket" panel channel
    memberRoleId: '528574587747958794',                  // Member role for CO/Admin ticket access
    roles: {
      normal: ['458273494048964619', '458277129973661719', '733974178797191189'],                   // RB member role, Server admin, RB admin, RB managers
      communityOfficer: ['989894740642263082'],         // CO role
      adminOfficer: ['810252560220946432'],             // Admin role
      compTeam: ['1291154622656020570', '1048696124233502760'],                 // Comp Team role, comp leader, comp manager
      whitelist: ['917911950120333323'],                // Whitelist role
    },
  },
  prospects: {
    categoryId: '660070542271053844',                    // Prospect staff category
    panelChannelId: '1476956067882864671',               // "Join RB" panel channel
    forumChannelId: '1237525233770958898',               // Forum channel for public prospect posts
    forumTags: {
      needFeedback: '1237529250542784542',               // Applied during prospect period
      openForVote: '1237529349255860274',                // Applied when vote starts
      // closed: '1238847921332551810',                  // Unused - threads deleted on rejection
    },
    loungeChannelId: '460898033794809856',              // Public announcements (voting, accepted)
    periodDays: 28,
    voteDaysBefore: 14,
    roles: ['1204763136830218260', '654022866261770270', '1213958671843860552', '1295470787934814259', '989894740642263082'],                      // Staff roles, trainee mentor, mentor, seniro mentor, recruitment officer, comm officer, rb managers
    prospectRoleId: '706053335106715650',               // Prospect role
    purgedRoleId: '1125873310182428693',                // Purged role (removed on accept)
    memberRoleId: '528574587747958794',                 // RB member role (granted on vote accept; pinged for vote)
    mentorRoleId: '654022866261770270',                 // Mentor role
    voiceChannelId: '1476956237110186195',               // Voice channel for invites
    memberHubChannelId: '1051879922643255306',            // Member hub channel
    meetTheMembersChannelId: '458279712213565440',       // Meet the members channel
    goingAwayChannelId: '1237155781531402270',            // Going away channel
    feedbackChannelId: '1237151891214041149',             // Prospect feedback channel
    voteEmojis: {
      yes: '1477315341469089926',                        // YES emoji ID
      no: '1477315341469089926',                         // NO emoji ID
      unsure: '1477315341469089926',                     // UNSURE emoji ID
    },
  },
  dm: {
    infoChannelId: '1164909963823558778',                  // Server info/rules channel
  },
  battlemetrics: {
    organisationId: '13904',
    prospectFlagId: '56d6c2a0-0549-11ed-bda3-ab665fd70dc4',
    memberFlagId: '60539480-0d14-11ec-a83f-b32d5968dd59',
  },
  seeding: {
    seedingServer: 'production',  // SQUADJS_SERVERS connection name used by the layer-rotation validator (name-based DB queries)
    // First-insert defaults for the seeding_config DB row. All live config (servers,
    // channels, role list, thresholds, tracker rules) is edited on the website /seeding page.
    defaultThreshold: 40,
    defaultResetThreshold: 20,
    defaultTime: '16:00',
    defaultTimezone: 'UTC',
    defaultRequiredSeedDays: 10,
    defaultRollingWindowDays: 30,
    defaultWhitelistDurationDays: 30,
    defaultMaxExtensionDays: 60,
    schedulerCheckMs: 60000,
  },
  slReward: {
    leaderboardChannelId: '1516397123007021087',          // SL rolling-7d leaderboard embed
    hypercareChannelId: '1516396946355654707',            // Launch hypercare: grant/extend/skip/error log
    hypercareVerbose: true,                               // Verbose during launch; flip to false to keep only run summaries
    dryRun: false,                                        // Live grants (straight to prod)
    clanId: 'cmq8eaiat03ym01qtcdgs7bri',                 // Squadleader whitelist clan
    server: 'main',
    thresholdHours: 5,                                    // Rolling-7d qualifying SL hours to earn whitelist
    rewardDays: 7,                                        // Whitelist length per grant/extend
    extendWhenRemainingHours: 24,                         // Extend an SL entry only when under this much time left
    grantIntervalMs: 1800000,                             // 30 min
    leaderboardIntervalMs: 10800000,                      // 3 h
  },
  serverStatus: {
    channelId: '1476956161566572705',                    // Server status channel
    updateIntervalMs: 60000,
  },
  configGuardian: {
    channelId: '1490634013503656006',                      // Config Guardian alerts channel
  },
  layerRotationValidator: {
    enabled: true,
    channelId: '1509632566548889773',                      // Prod: live rotation status channel
    errorRoleIds: ['1225894972084060290', '733974178797191189'],  // Pinged on SFTP-mode errors AND authorised to post in Channel mode
    intervalMs: 5 * 60 * 1000,
    squadUtilsUrl: process.env.SQUAD_UTILS_URL || 'https://squadutils.org/api/v3/parse',
    serverCfgName: 'Server.cfg',
    layerRotationName: 'LayerRotation.cfg',
  },
  alerts: {
    channelId: '1423733551257489501',                      // Error alerts + unhandled-DM log (same channel)
    dedupeWindowMs: 60000,                                 // Collapse identical errors within this window
    startupNotice: true,                                   // Post "Bot online" embed on ready
    shutdownNotice: true,                                  // Post "Bot shutting down" embed on SIGTERM/SIGINT
  },
  purged: {
    roleId: '1125873310182428693',                         // Purged member role
    channelId: '1268287942284148817',                      // Purged members info channel
  },
  verification: {
    panelChannelId: '1478305542328815769',                                  // Channel where the verify panel is posted
    logChannelId: '1478305637921460334',                                    // Staff channel for verification logs
    roleId: '1164520968421646419',                                          // Role assigned on successful verification
  },
  moderation: {
    enabled: true,
    channelId: '1497185678281408592',                    // Daily moderation report destination
    productionServerName: 'RB | Royal Battalion [ENG] discord.gg/royalbattalion', // exact squadjs_servers.name; null = use latest-match fallback
    dailyTime: '08:00',                                  // HH:MM in `timezone`
    timezone: 'UTC',
    schedulerCheckMs: 60000,
    windowHours: 24,
    chunkThresholdMessages: 3500,                        // chunk before sending to Claude above this
    maxOutputTokens: 4000,
    repeatOffenderLookbackDays: 30,
  },
};
