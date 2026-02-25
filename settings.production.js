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
    id: '',                           // Production guild ID
  },
  channels: {},
  roles: {},
  tickets: {
    categoryId: '',                   // Ticket category
    panelChannelId: '',               // "Create Ticket" panel channel
    roles: {
      normal: [''],                   // RB member role
      communityOfficer: [''],         // CO role
      adminOfficer: [''],             // Admin role
      compTeam: [''],                 // Comp Team role
      whitelist: [''],                // Whitelist role
    },
  },
  prospects: {
    categoryId: '',                   // Prospect category
    panelChannelId: '',               // "Join RB" panel channel
    forumChannelId: '',               // Forum channel for public posts
    loungeChannelId: '',              // Public announcements (voting, accepted)
    periodDays: 21,
    voteDaysBefore: 7,
    roles: [''],                      // Staff roles
    prospectRoleId: '',               // Prospect role
    whitelistRoleId: '',              // Whitelist role
    mentorRoleId: '',                 // Mentor role
    voiceChannelId: '',               // Voice channel for invites
    voteEmojis: {
      yes: '',                        // YES emoji ID
      no: '',                         // NO emoji ID
      unsure: '',                     // UNSURE emoji ID
    },
  },
  dm: {
    infoChannelId: '',                  // Server info/rules channel
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
  serverStatus: {
    channelId: '',                    // Server status channel
    updateIntervalMs: 60000,
  },
};
