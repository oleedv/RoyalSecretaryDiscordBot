import { describe, it, expect, mock, beforeEach } from 'bun:test';

// Stub the ticket service + relay so the test never touches the DB or Discord.
let openTicketQueue = [];
let closingTicket = null;
let reopenResult = {};
const forwarded = [];

mock.module('../../../src/services/ticket/ticketService.js', () => ({
  getOpenTicketByUser: async () => (openTicketQueue.length ? openTicketQueue.shift() : null),
  getClosingTicketByUser: async () => closingTicket,
  reopenTicket: async () => reopenResult,
  rebuildTicketInfoEmbed: async () => {},
}));

mock.module('../../../src/handlers/ticketMessages.js', () => ({
  handleDM: async (message, ticket) => { forwarded.push({ message, ticket }); },
  handleGuild: async () => false,
}));

const { handleDM } = await import('../../../src/events/messageCreate.js');

function makeMessage() {
  const replies = [];
  return {
    author: { id: 'U1' },
    reply: async (payload) => { replies.push(payload); },
    replies,
    client: {},
  };
}

describe('handleDM reopen race (closing ticket)', () => {
  beforeEach(() => {
    openTicketQueue = [];
    closingTicket = null;
    reopenResult = {};
    forwarded.length = 0;
  });

  it('forwards to the now-open ticket when a concurrent DM already reopened it', async () => {
    // Top-of-handler open check -> null; a closing ticket exists; this reopen
    // loses the race; the re-fetch finds the ticket the winner reopened.
    const openTicket = { id: 42, channel_id: 'C1', status: 'open' };
    openTicketQueue = [null, openTicket];
    closingTicket = { id: 42, channel_id: 'C1', status: 'closing' };
    reopenResult = { error: 'Ticket already reopened or closed.' };

    const message = makeMessage();
    await handleDM(message);

    expect(forwarded).toHaveLength(1);
    expect(forwarded[0].ticket).toBe(openTicket);
    expect(message.replies).toHaveLength(0); // no false "unavailable" rejection
  });

  it('tells the user to open a new ticket when nothing is open after a failed reopen', async () => {
    openTicketQueue = [null, null];
    closingTicket = { id: 42, channel_id: 'C1', status: 'closing' };
    reopenResult = { error: 'Ticket already reopened or closed.' };

    const message = makeMessage();
    await handleDM(message);

    expect(forwarded).toHaveLength(0);
    expect(message.replies).toHaveLength(1);
    expect(message.replies[0].embeds[0].data.description).toContain('open a new ticket');
  });
});
