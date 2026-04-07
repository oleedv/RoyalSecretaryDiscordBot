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
    ],
    partials: [Partials.Channel, Partials.Message, Partials.User],
    presence: {
      activities: [{ name: 'DM for support', type: ActivityType.Custom }],
      status: 'online',
    },
  });

  client.commands = new Collection();

  // Workaround: discord.js may silently drop DM messageCreate events when
  // the DM channel isn't cached, even with Partials.Channel. Detect this
  // via the raw gateway event and manually fetch + re-emit.
  client.on('raw', async (packet) => {
    if (packet.t !== 'MESSAGE_CREATE' || packet.d?.guild_id) return;

    const cached = client.channels.cache.has(packet.d.channel_id);
    if (cached) return; // discord.js will handle it normally

    log.info({ authorId: packet.d?.author?.id, channelId: packet.d?.channel_id }, 'DM channel not cached, fetching manually');
    try {
      const channel = await client.channels.fetch(packet.d.channel_id);
      const message = await channel.messages.fetch(packet.d.id);
      client.emit('messageCreate', message);
    } catch (err) {
      log.error({ err }, 'Failed to fetch uncached DM channel/message');
    }
  });

  await loadCommands(client);
  await loadEvents(client);

  return client;
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
}
