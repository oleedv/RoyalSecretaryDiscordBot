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
    loungeChannelId: '',
    periodDays: 28,
    voteDaysBefore: 14,
    roles: ['195412349153312768'],
    prospectRoleId: '1410750309940072568',
    whitelistRoleId: '1406672770242449458',
    mentorRoleId: '1406672908641894400',
    voiceChannelId: '1143282482150654126',
    voteEmojis: {
      yes: '1472142752538955807',
      no: '1472142752538955807',
      unsure: '1472142752538955807',
    },
  },
  seedTracker: {
    progressionChannelId: '',                            // Channel for progression/milestone embeds
    leaderboardChannelId: '',                            // Channel for monthly leaderboard
    requiredSeedDays: 10,
    rollingWindowDays: 30,
    whitelistDurationDays: 30,
    maxExtensionDays: 60,
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
};
