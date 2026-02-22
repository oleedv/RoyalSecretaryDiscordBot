// Staging environment settings (test Discord server)
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
    roles: {
      normal: ['1406672770242449458'],
      communityOfficer: ['1406672908641894400'],
      adminOfficer: ['1406683504829268139'],
    },
  },
  prospects: {
    categoryId: '1473786285943685190',
    panelChannelId: '1473761516888264805',
    forumChannelId: '1473786537975222354',
    loungeChannelId: '1143282482150654125',
    periodDays: 21,
    voteDaysBefore: 7,
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
};
