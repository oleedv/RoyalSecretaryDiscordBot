// Staging environment settings (test Discord server)
// Secrets (tokens, DB credentials) belong in GitHub Secrets — not here.

export default {
  bot: {
    name: 'Royal Secretary',
    version: '1.0.0',
  },
  webBaseUrl: 'https://stg.royalbattalion.xyz',
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
    loungeChannelId: '1143282482150654125',
    periodDays: 28,
    voteDaysBefore: 14,
    roles: ['1406672908641894400', '1406672908641894400'],
    prospectRoleId: '1410750309940072568',
    whitelistRoleId: '1406672770242449458',
    mentorRoleId: '1406672908641894400',
    voiceChannelId: '1143282482150654126',
    memberHubChannelId: '1051879922643255306',
    meetTheMembersChannelId: '458279712213565440',
    goingAwayChannelId: '1237155781531402270',
    feedbackChannelId: '1237151891214041149',
    voteEmojis: {
      yes: '1472142752538955807',
      no: '1472142752538955807',
      unsure: '1472142752538955807',
    },
  },
  dm: {
    infoChannelId: '1474146687344836691',
  },
  battlemetrics: {
    organisationId: '13904',
    prospectFlagId: '56d6c2a0-0549-11ed-bda3-ab665fd70dc4',
    memberFlagId: '60539480-0d14-11ec-a83f-b32d5968dd59',
  },
  seeding: {
    seedingServer: 'staging',
    defaultThreshold: 40,
    defaultResetThreshold: 20,
    defaultTime: '16:00',
    defaultTimezone: 'UTC',
    schedulerCheckMs: 60000,
  },
  seedTracker: {
    progressionChannelId: '',                            // Channel for progression/milestone embeds
    leaderboardChannelId: '',                            // Channel for monthly leaderboard
    requiredSeedDays: 10,
    rollingWindowDays: 30,
    whitelistDurationDays: 30,
    maxExtensionDays: 60,
  },
  serverStatus: {
    channelId: '1476163752863862875',
    updateIntervalMs: 60000,
  },
  configGuardian: {
    channelId: '1490634043639857182',                      // Config Guardian alerts channel
  },
  alerts: {
    channelId: '1496854948506239127',                      // Error alerts + unhandled-DM log (same channel)
    dedupeWindowMs: 60000,                                 // Collapse identical errors within this window
    startupNotice: true,                                   // Post "Bot online" embed on ready
    shutdownNotice: true,                                  // Post "Bot shutting down" embed on SIGTERM/SIGINT
  },
  purged: {
    roleId: '1491082532236820742',                         // Purged member role
    channelId: '1491095974771167423',                      // Purged members info channel
  },
  verification: {
    panelChannelId: '1478305781999730804',                                  // Channel where the verify panel is posted
    logChannelId: '1478305794813460490',                                    // Staff channel for verification logs
    roleId: '1478305879307845725',                                          // Role assigned on successful verification
  },
  moderation: {
    enabled: false,                                       // Off in staging until a channel is set
    channelId: '',
    productionServerName: null,                           // Fall back to latest-match server in staging
    dailyTime: '08:00',
    timezone: 'UTC',
    schedulerCheckMs: 60000,
    windowHours: 24,
    chunkThresholdMessages: 3500,
    maxOutputTokens: 4000,
    repeatOffenderLookbackDays: 30,
  },
};
