import { describe, it, expect } from 'bun:test';
import { sendOrQueueDm } from './dmQueue.js';

describe('sendOrQueueDm delivery', () => {
  it('delivers the DM as an embed, not raw text', async () => {
    const sends = [];
    const client = {
      users: { fetch: async () => ({ send: async (payload) => { sends.push(payload); } }) },
    };

    const ok = await sendOrQueueDm(client, 'D1', 'Your squad-leader whitelist reward is active!');

    expect(ok).toBe(true);
    expect(sends).toHaveLength(1);
    expect(sends[0].embeds).toBeDefined();
    expect(sends[0].embeds[0].data.description).toContain('squad-leader whitelist reward');
  });

  it('returns false without throwing when there is no discord id', async () => {
    const client = { users: { fetch: async () => { throw new Error('should not be called'); } } };
    const ok = await sendOrQueueDm(client, null, 'anything');
    expect(ok).toBe(false);
  });
});
