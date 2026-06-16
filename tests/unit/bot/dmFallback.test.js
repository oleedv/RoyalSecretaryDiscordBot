import { describe, it, expect } from 'bun:test';
import { EventEmitter } from 'node:events';
import { installDmFallback } from '../../../src/bot.js';

const silentLog = { info() {}, error() {}, warn() {}, debug() {} };
const flush = () => new Promise((resolve) => setTimeout(resolve, 25));

function makeClient() {
  const client = new EventEmitter();
  client.channels = {
    fetched: [],
    fetch(id) {
      this.fetched.push(id);
      return Promise.resolve({
        messages: { fetch: (mid) => Promise.resolve({ id: mid, guildId: null }) },
      });
    },
  };
  return client;
}

describe('installDmFallback', () => {
  it('does not re-deliver a DM that discord.js already emitted', async () => {
    const client = makeClient();
    installDmFallback(client, silentLog);

    let delivered = 0;
    client.on('messageCreate', () => { delivered++; });

    // Gateway dispatch order: the raw event fires first, then discord.js emits
    // messageCreate natively in the same tick (WebSocketManager: emit(Raw) -> handlePacket).
    client.emit('raw', { t: 'MESSAGE_CREATE', d: { id: 'M1', channel_id: 'C1', author: { id: 'U1' } } });
    client.emit('messageCreate', { id: 'M1', guildId: null });

    await flush();

    expect(delivered).toBe(1);
    expect(client.channels.fetched).toEqual([]); // fallback must not fetch when native delivered
  });

  it('delivers a DM that discord.js dropped (uncached channel)', async () => {
    const client = makeClient();
    installDmFallback(client, silentLog);

    let delivered = 0;
    client.on('messageCreate', () => { delivered++; });

    // Raw fires but discord.js never emits messageCreate -- the drop the workaround exists for.
    client.emit('raw', { t: 'MESSAGE_CREATE', d: { id: 'M2', channel_id: 'C2', author: { id: 'U2' } } });

    await flush();

    expect(delivered).toBe(1);
    expect(client.channels.fetched).toEqual(['C2']); // fallback fetched + re-emitted
  });

  it('ignores guild messages on the raw channel', async () => {
    const client = makeClient();
    installDmFallback(client, silentLog);

    let delivered = 0;
    client.on('messageCreate', () => { delivered++; });

    client.emit('raw', { t: 'MESSAGE_CREATE', d: { id: 'M3', channel_id: 'C3', guild_id: 'G1', author: { id: 'U3' } } });

    await flush();

    expect(delivered).toBe(0);
    expect(client.channels.fetched).toEqual([]);
  });
});
