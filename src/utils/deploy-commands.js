import { REST, Routes } from 'discord.js';
import { readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import logger from '../logger.js';
import config, { validateConfig } from '../config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const log = logger.child({ module: 'deploy' });

async function deployCommands() {
  validateConfig();

  const commandsDir = join(__dirname, '..', 'commands');
  const files = readdirSync(commandsDir).filter((f) => f.endsWith('.js'));
  const commands = [];

  for (const file of files) {
    const filePath = join(commandsDir, file);
    const module = await import(pathToFileURL(filePath).href);
    const command = module.default;

    if (command?.data) {
      commands.push(command.data.toJSON());
      log.info(`Prepared command: /${command.data.name}`);
    }
  }

  const rest = new REST().setToken(config.discord.token);

  if (config.guild?.id) {
    log.info(`Deploying ${commands.length} command(s) to guild ${config.guild.id}`);
    await rest.put(
      Routes.applicationGuildCommands(config.discord.clientId, config.guild.id),
      { body: commands }
    );
  } else {
    log.info(`Deploying ${commands.length} command(s) globally`);
    await rest.put(
      Routes.applicationCommands(config.discord.clientId),
      { body: commands }
    );
  }

  log.info('Commands deployed successfully');
}

deployCommands().catch((err) => {
  log.error({ err }, 'Failed to deploy commands');
  process.exit(1);
});
