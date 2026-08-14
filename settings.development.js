// Development environment settings (local dev)
// Secrets (tokens, DB credentials) belong in GitHub Secrets — not here.

export default {
  bot: {
    name: 'Royal Secretary',
    version: '1.0.0',
  },
  guild: {
    id: '1143282481253077002',
  },
  channels: {},
  roles: {},
  tickets: {
    categoryId: '1473728123991490560',
    panelChannelId: '1473728223018750116',
    memberRoleId: '1406672770242449458',                 // Member role for CO/Admin ticket access
    roles: {
      normal: ['1406672770242449458'],
      communityOfficer: ['1406672908641894400'],
      adminOfficer: ['1406683504829268139'],
      compTeam: ['1475864404678414408'],
      whitelist: ['1475864507619475577'],
    },
  },
  prospects: {
    categoryId: '1473786285943685190',
    panelChannelId: '1473761516888264805',
    forumChannelId: '1473786537975222354',
    forumTags: {
      needFeedback: null,                                // TODO: populate from staging forum tag IDs
      openForVote: null,                                 // TODO: populate from staging forum tag IDs
    },
    loungeChannelId: '',
    periodDays: 28,
    voteDaysBefore: 14,
    roles: ['195412349153312768'],
    prospectRoleId: '1410750309940072568',
    memberRoleId: '1406672770242449458',
    mentorRoleId: '1406672908641894400',
    voiceChannelId: '1143282482150654126',
    memberHubChannelId: '1051879922643255306',
    meetTheMembersChannelId: '458279712213565440',
    goingAwayChannelId: '1237155781531402270',
    feedbackChannelId: '1237151891214041149',
    prospectLoungeChannelId: '',                          // set to a dev channel to test the prospect-lounge welcome
    prospectInfoChannelId: '',
    prospectIntroChannelId: '',
    prospectAwayChannelId: '',
    voteEmojis: {
      yes: '1472142752538955807',
      no: '1472142752538955807',
      unsure: '1472142752538955807',
    },
  },
  seeding: {
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
    // Inert in development: no channels, dry-run on.
    leaderboardChannelId: '',
    hypercareChannelId: '',
    hypercareVerbose: false,
    dryRun: true,
    clanId: 'cmq8eaiat03ym01qtcdgs7bri',
    server: 'main',
    thresholdHours: 5,
    rewardDays: 7,
    extendWhenRemainingHours: 24,
    grantIntervalMs: 1800000,
    leaderboardIntervalMs: 10800000,
  },
  commsWatch: {
    enabled: true,
    serverId: 1,              // squadjs_servers.id (1 = Main ENG server, 2 = Battle)
    serverLabel: 'Main',      // friendly name shown in the board/alert embeds
    tickMs: 60000,
    boardRefreshMs: 120000,   // ~2 min board refresh for duration ticks
    blipGraceMs: 60000,       // tolerate voice blips shorter than this
    prospectThresholdMs: 900000, // 15 min continuous off-comms before alerting
    afkChannelId: null,       // null => use guild.afkChannelId
  },
  purged: {
    roleId: '1491082532236820742',                         // Purged member role
    channelId: '1491095974771167423',                      // Purged members info channel
  },
  verification: {
    panelChannelId: '',                                  // Channel where the verify panel is posted
    logChannelId: '',                                    // Staff channel for verification logs
    roleId: '',                                          // Role assigned on successful verification
  },
  serverStatus: {
    channelId: '',
    updateIntervalMs: 60000,
  },
  quickStatus: {
    channelId: '',                                       // Leave empty in dev unless testing
    updateIntervalMs: 60000,
    serverId: 1,
  },
  alerts: {
    channelId: '',                                       // Leave empty in dev so local runs stay silent
    dedupeWindowMs: 60000,
    startupNotice: false,
    shutdownNotice: false,
  },
  moderation: {
    enabled: false,                                       // Off in dev; use /modreport to test on demand
    channelId: '',
    productionServerName: null,
    dailyTime: '08:00',
    timezone: 'UTC',
    schedulerCheckMs: 60000,
    windowHours: 24,
    chunkThresholdMessages: 3500,
    maxOutputTokens: 4000,
    repeatOffenderLookbackDays: 30,
  },
  layerRotationValidator: {
    enabled: false,
  },
};
