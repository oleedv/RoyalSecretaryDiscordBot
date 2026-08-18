import { describe, expect, test } from 'bun:test';
import {
  QUICK_STATUS_FOOTER,
  MISSING_DISCORD_TITLE,
  isQuickStatusMessage,
  collectQuickStatusMessages,
  selectQuickStatusMessage,
  editOrCreateQuickStatus,
} from '../quickStatusMessages.js';

const BOT_ID = 'bot-1';

function msg({
  id,
  authorId = BOT_ID,
  createdTimestamp = 1,
  footer = QUICK_STATUS_FOOTER,
  title = '🟢  Royal Battalion One',
  embeds,
} = {}) {
  return {
    id,
    author: { id: authorId },
    createdTimestamp,
    embeds: embeds ?? [{ footer: { text: footer }, title }],
    delete: async () => {},
  };
}

describe('isQuickStatusMessage', () => {
  test('recognizes the live-stats footer', () => {
    expect(isQuickStatusMessage(msg({ id: '1' }), BOT_ID)).toBe(true);
  });

  test('recognizes the missing-discord title even if footer differs', () => {
    const m = msg({
      id: '2',
      footer: 'In-game but not in Discord voice',
      title: MISSING_DISCORD_TITLE,
    });
    expect(isQuickStatusMessage(m, BOT_ID)).toBe(true);
  });

  test('rejects other bot embeds in the same channel', () => {
    const commsBoard = msg({
      id: '3',
      footer: 'Updates every couple of minutes',
      title: 'Comms board',
    });
    expect(isQuickStatusMessage(commsBoard, BOT_ID)).toBe(false);
  });

  test('rejects embeds from another bot', () => {
    expect(isQuickStatusMessage(msg({ id: '4', authorId: 'other-bot' }), BOT_ID)).toBe(false);
  });
});

describe('selectQuickStatusMessage', () => {
  test('picks the oldest matching message and ignores unrelated bot embeds', () => {
    const messages = [
      msg({ id: 'new', createdTimestamp: 30 }),
      msg({
        id: 'comms',
        createdTimestamp: 5,
        footer: 'Updates every couple of minutes',
        title: 'Comms board',
      }),
      msg({ id: 'old', createdTimestamp: 10 }),
    ];
    expect(selectQuickStatusMessage(messages, BOT_ID).id).toBe('old');
  });

  test('returns null when no quick-status message exists', () => {
    expect(selectQuickStatusMessage([msg({
      id: 'x',
      footer: 'other',
      title: 'other',
    })], BOT_ID)).toBeNull();
  });
});

describe('collectQuickStatusMessages', () => {
  test('collects only our status messages from a mixed channel', () => {
    const messages = [
      msg({ id: 'qs' }),
      msg({ id: 'other', footer: 'nope', title: 'nope' }),
    ];
    expect(collectQuickStatusMessages(messages, BOT_ID).map((m) => m.id)).toEqual(['qs']);
  });
});

describe('editOrCreateQuickStatus', () => {
  test('edits the existing message and never deletes', async () => {
    const events = [];
    const existing = {
      id: 'old',
      edit: async () => { events.push('edit'); },
      delete: async () => { events.push('delete'); },
    };
    const channel = {
      send: async () => {
        events.push('send');
        return { id: 'new' };
      },
    };

    const result = await editOrCreateQuickStatus({
      channel,
      embeds: [{}],
      existing,
    });
    expect(result.id).toBe('old');
    expect(events).toEqual(['edit']);
  });

  test('sends only when no message exists', async () => {
    const events = [];
    const channel = {
      send: async () => {
        events.push('send');
        return { id: 'new' };
      },
    };
    const result = await editOrCreateQuickStatus({
      channel,
      embeds: [{}],
      existing: null,
    });
    expect(result.id).toBe('new');
    expect(events).toEqual(['send']);
  });
});
