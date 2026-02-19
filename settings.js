// Secrets (tokens, DB credentials) belong in .env — not here.

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
    categoryId: '1473728123991490560',       // Category where ticket channels are created
    panelChannelId: '1473728223018750116',   // Channel where the "Create Ticket" embed lives
    roles: {
      normal: ['1406672770242449458'], // RB member
      communityOfficer: ['1406672908641894400'],
      adminOfficer: ['1406683504829268139'],
    },
  },
  prospects: {
    categoryId: '1473786285943685190',           // Category for prospect channels
    panelChannelId: '1473761516888264805',       // Channel for "Join RB" embed
    forumChannelId: '1473786537975222354',       // GuildForum channel for public posts
    periodDays: 21,           // Prospect period length
    voteDaysBefore: 7,        // Days before end to post vote
    roles: ["195412349153312768"],                // Staff roles that see prospect channels
    prospectRoleId: '1410750309940072568',       // Role given to prospect on application
    whitelistRoleId: '1406672770242449458',      // Role added when voting starts
    mentorRoleId: '1406672908641894400',                              // Role pinged when a new prospect arrives
    voiceChannelId: '1143282482150654126',                            // Voice channel linked in "Invite to Voice" button
    voteEmojis: {
      yes: '1472142752538955807',                // Custom emoji ID for YES vote
      no: '1472142752538955807',                 // Custom emoji ID for NO vote
      unsure: '1472142752538955807',             // Custom emoji ID for UNSURE vote
    },
  },
};
