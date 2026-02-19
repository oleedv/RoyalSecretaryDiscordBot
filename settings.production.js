// Production environment settings (live Discord server)
// Secrets (tokens, DB credentials) belong in GitHub Secrets — not here.
// TODO: Replace all IDs below with production Discord server values.

export default {
  bot: {
    name: 'Royal Secretary',
    version: '1.0.0',
  },
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
    },
  },
  prospects: {
    categoryId: '',                   // Prospect category
    panelChannelId: '',               // "Join RB" panel channel
    forumChannelId: '',               // Forum channel for public posts
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
};
