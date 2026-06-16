import { describe, it, expect, mock } from 'bun:test';

// memberLeave.js pulls in prospect services at import time; stub them so the
// test never touches the DB.
mock.module('../../../src/services/prospect/prospectService.js', () => ({
  getOpenProspectsByMentor: async () => [],
  unclaimProspect: async () => {},
}));
mock.module('../../../src/services/prospect/teamRoleService.js', () => ({
  removeTeamRole: async () => {},
  deleteTeamRole: async () => {},
}));

const { handleTicketMemberLeave } = await import('../../../src/handlers/memberLeave.js');

function makeGuildCapturing() {
  const sent = [];
  const channel = { send: async (payload) => { sent.push(payload); } };
  const guild = { channels: { fetch: async () => channel } };
  return { guild, sent };
}

const member = { id: 'U1', user: { tag: 'User#1' } };

describe('handleTicketMemberLeave', () => {
  it('says the ticket is still open when the leaver had an open ticket', async () => {
    const { guild, sent } = makeGuildCapturing();
    await handleTicketMemberLeave({ id: 1, channel_id: 'C1', status: 'open' }, member, guild);
    expect(sent).toHaveLength(1);
    const desc = sent[0].embeds[0].data.description;
    expect(desc).toContain('User#1');
    expect(desc).toContain('still open');
  });

  it('mentions the closing grace period when the ticket is closing', async () => {
    const { guild, sent } = makeGuildCapturing();
    await handleTicketMemberLeave({ id: 1, channel_id: 'C1', status: 'closing' }, member, guild);
    expect(sent).toHaveLength(1);
    const desc = sent[0].embeds[0].data.description;
    expect(desc).toContain('grace period');
  });
});
