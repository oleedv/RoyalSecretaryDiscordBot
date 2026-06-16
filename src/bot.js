import { ActivityType, Client, Collection, GatewayIntentBits, Partials } from 'discord.js';
import { readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import logger from './logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const log = logger.child({ module: 'bot' });

export async function createBot() {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.GuildMessageReactions,
    ],
    partials: [Partials.Channel, Partials.Message, Partials.User, Partials.Reaction],
    presence: {
      activities: [{ name: 'DM for support', type: ActivityType.Custom }],
      status: 'online',
    },
  });

  client.commands = new Collection();

  attachClientDiagnostics(client);

  installDmFallback(client);

  const commandCount = await loadCommands(client);
  const eventCount = await loadEvents(client);

  return { client, commandCount, eventCount };
}

/**
 * Safety net for a discord.js quirk where DM messageCreate events were observed to be
 * dropped for uncached DM channels (see commit 876f502). We watch the raw gateway event
 * and re-emit the DM ourselves -- but ONLY if discord.js didn't already surface it.
 *
 * discord.js dispatches each packet by emitting 'raw' and THEN running its own handler
 * synchronously in the same tick; with Partials.Channel it DOES emit DM messages. The old
 * guard checked channels.cache before the native handler ran, so for an uncached DM both
 * paths fired and the message was double-posted into the staff ticket channel. Here we
 * defer one tick, let the native handler record the message id, and skip the re-emit when
 * it already fired -- keeping the dropped-DM safety net without the double.
 */
export function installDmFallback(client, logArg = log) {
  const surfacedDmIds = new Set();
  const rememberDm = (id) => {
    if (!id) return;
    surfacedDmIds.add(id);
    const timer = setTimeout(() => surfacedDmIds.delete(id), 60_000);
    timer.unref?.();
  };

  // Record every DM messageCreate that reaches the client (native or re-emitted below).
  client.on('messageCreate', (message) => {
    if (!message.guildId) rememberDm(message.id);
  });

  client.on('raw', async (packet) => {
    if (packet.t !== 'MESSAGE_CREATE' || packet.d?.guild_id) return;

    // Let discord.js's own handler (which runs right after this raw event, same tick) emit first.
    await new Promise((resolve) => setImmediate(resolve));
    if (surfacedDmIds.has(packet.d.id)) return; // already delivered -- don't double-post

    logArg.info({ authorId: packet.d?.author?.id, channelId: packet.d?.channel_id }, 'DM not delivered by discord.js, using raw fallback');
    try {
      const channel = await client.channels.fetch(packet.d.channel_id);
      const message = await channel.messages.fetch(packet.d.id);
      client.emit('messageCreate', message);
    } catch (err) {
      logArg.error({ err }, 'Failed to fetch uncached DM channel/message');
    }
  });
}

function attachClientDiagnostics(client) {
  const diag = logger.child({ module: 'discordClient' });

  client.on('error', (err) => diag.error({ err }, 'Client error'));
  client.on('warn', (msg) => diag.warn({ msg }, 'Client warn'));
  client.on('invalidated', () => diag.error('Client session invalidated - bot must restart'));

  client.rest.on('rateLimited', (info) => {
    // Channel PATCH (name/topic edits) is capped at 2/10min per channel by Discord —
    // unavoidable, the REST client just waits it out. Log at debug to keep the warn
    // channel clean; other routes still surface as warnings.
    const isChannelEdit = info?.method === 'PATCH' && /^\/channels\/\d+$/.test(info?.url ?? '');
    const level = isChannelEdit ? 'debug' : 'warn';
    diag[level]({
      timeToReset: info?.timeToReset,
      limit: info?.limit,
      method: info?.method,
      url: info?.url,
      route: info?.route,
      majorParameter: info?.majorParameter,
      global: info?.global,
    }, 'Discord REST rate limit hit');
  });
  client.rest.on('invalidRequestWarning', (info) => diag.warn({
    count: info?.count,
    remainingTime: info?.remainingTime,
  }, 'Discord REST invalid request warning'));

  client.on('shardError', (err, shardId) => diag.error({ err, shardId }, 'Shard error'));
  client.on('shardDisconnect', (event, shardId) => diag.warn({
    shardId,
    code: event?.code,
    reason: event?.reason,
  }, 'Shard disconnected'));
  client.on('shardReconnecting', (shardId) => diag.warn({ shardId }, 'Shard reconnecting'));
  client.on('shardResume', (shardId, replayedEvents) => diag.info({ shardId, replayedEvents }, 'Shard resumed'));
  client.on('shardReady', (shardId, unavailableGuilds) => diag.info({
    shardId,
    unavailableGuilds: unavailableGuilds?.size ?? 0,
  }, 'Shard ready'));
}

async function loadCommands(client) {
  const commandsDir = join(__dirname, 'commands');
  const files = readdirSync(commandsDir).filter((f) => f.endsWith('.js'));

  for (const file of files) {
    const filePath = join(commandsDir, file);
    const module = await import(pathToFileURL(filePath).href);
    const command = module.default;

    if (!command?.data?.name || !command?.execute) {
      log.warn(`Skipping invalid command file: ${file}`);
      continue;
    }

    client.commands.set(command.data.name, command);
    log.debug(`Loaded command: /${command.data.name}`);
  }

  log.info(`Loaded ${client.commands.size} command(s)`);
  return client.commands.size;
}

async function loadEvents(client) {
  const eventsDir = join(__dirname, 'events');
  const files = readdirSync(eventsDir).filter((f) => f.endsWith('.js'));
  let count = 0;

  for (const file of files) {
    const filePath = join(eventsDir, file);
    let module;
    try {
      module = await import(pathToFileURL(filePath).href);
    } catch (err) {
      console.error(`Failed to load event ${file}:`, err);
      throw err;
    }
    const event = module.default;

    if (!event?.name || !event?.execute) {
      log.warn(`Skipping invalid event file: ${file}`);
      continue;
    }

    if (event.once) {
      client.once(event.name, (...args) => event.execute(...args));
    } else {
      client.on(event.name, (...args) => event.execute(...args));
    }

    log.debug(`Loaded event: ${event.name}`);
    count++;
  }

  log.info(`Loaded ${count} event(s)`);
  return count;
}
