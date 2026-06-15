import { describe, it, expect, mock, beforeEach } from 'bun:test';

// Mock the service layer so the test never touches the DB.
let entryCount = 0;
mock.module('../../../src/services/giveaway/giveawayService.js', () => ({
  countEntries: async () => entryCount,
}));

const { refreshEntryMessage } = await import('../../../src/services/giveaway/giveawayMessage.js');

function makeGiveaway(overrides = {}) {
  return {
    id: 7,
    prize: 'A Game',
    month_label: 'June 2026',
    draw_at: '2026-06-30T23:59:59Z',
    window_days: 30,
    min_hours: 5,
    hours_weight: 1,
    seed_weight: 2,
    vote_weight: 1,
    entry_channel_id: 'chan-1',
    entry_message_id: 'msg-1',
    ...overrides,
  };
}

function makeClient({ message } = {}) {
  const editSpy = mock(async () => {});
  const channel = {
    messages: { fetch: mock(async () => (message === undefined ? { edit: editSpy } : message)) },
  };
  const client = {
    channels: { fetch: mock(async () => channel) },
  };
  return { client, channel, editSpy };
}

describe('refreshEntryMessage', () => {
  beforeEach(() => {
    entryCount = 0;
  });

  it('edits the stored entry message with the current entry count', async () => {
    entryCount = 3;
    const { client, editSpy } = makeClient();

    await refreshEntryMessage(client, makeGiveaway());

    expect(editSpy).toHaveBeenCalledTimes(1);
    const payload = editSpy.mock.calls[0][0];
    expect(payload.embeds[0].data.description).toContain('Entries so far: **3**');
    expect(payload.components).toHaveLength(1); // Enter button row preserved
  });

  it('no-ops when entry_message_id is missing', async () => {
    const { client, editSpy } = makeClient();

    await refreshEntryMessage(client, makeGiveaway({ entry_message_id: null }));

    expect(client.channels.fetch).not.toHaveBeenCalled();
    expect(editSpy).not.toHaveBeenCalled();
  });

  it('does not throw when the message is not found', async () => {
    const { client } = makeClient({ message: null });

    await expect(refreshEntryMessage(client, makeGiveaway())).resolves.toBeUndefined();
  });
});
