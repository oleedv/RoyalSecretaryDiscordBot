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
    categoryId: '1214968513039704154',                   // Prospect category
    panelChannelId: '1476956067882864671',               // "Join RB" panel channel
    forumChannelId: '1237525233770958898',               // Forum channel for public prospect posts
    loungeChannelId: '1476955931794473141',              // Public announcements (voting, accepted)
    periodDays: 21,
    voteDaysBefore: 7,
    roles: ['1204763136830218260', '654022866261770270', '1213958671843860552', '1295470787934814259', '989894740642263082', '733974178797191189'],                      // Staff roles, trainee mentor, mentor, seniro mentor, recruitment officer, comm officer, rb managers
    prospectRoleId: '706053335106715650',               // Prospect role
    whitelistRoleId: '528574587747958794',              // Whitelist role aka rb member
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
    defaultThreshold: 40,
    defaultResetThreshold: 20,
    defaultTime: '16:00',
    defaultTimezone: 'UTC',
    schedulerCheckMs: 60000,
  },
  seedTracker: {
    progressionChannelId: '1490779113110110399',          // Channel for progression/milestone embeds
    leaderboardChannelId: '1490779164855242894',          // Channel for monthly leaderboard
    requiredSeedDays: 10,
    rollingWindowDays: 30,
    whitelistDurationDays: 30,
    maxExtensionDays: 60,
  },
  serverStatus: {
    channelId: '1476956161566572705',                    // Server status channel
    updateIntervalMs: 60000,
  },
  configGuardian: {
    channelId: '1490634013503656006',                      // Config Guardian alerts channel
  },
  verification: {
    panelChannelId: '1478305542328815769',                                  // Channel where the verify panel is posted
    logChannelId: '1478305637921460334',                                    // Staff channel for verification logs
    roleId: '1164520968421646419',                                          // Role assigned on successful verification
  },
};
