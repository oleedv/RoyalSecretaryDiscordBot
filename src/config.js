import settings from '../settings.js';
import { parseSquadJsServers } from './config/parseSquadJsServers.js';

const requiredEnvVars = ['DISCORD_TOKEN', 'DISCORD_CLIENT_ID', 'DB_HOST', 'DB_USER', 'DB_PASSWORD', 'DB_NAME'];

export function validateConfig() {
  const missing = requiredEnvVars.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}

const config = Object.freeze({
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY || null,
  },
  discord: {
    token: process.env.DISCORD_TOKEN,
    clientId: process.env.DISCORD_CLIENT_ID,
  },
  database: {
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || '3306', 10),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    databases: {
      secretary: process.env.DB_NAME,
      squadjs: 'SquadJS',
      website: process.env.WEBSITE_DB_NAME,
    },
  },
  squadjs: parseSquadJsServers(process.env.SQUADJS_SERVERS),
  ...settings,
  steam: {
    ...settings.steam,
    apiKey: process.env.STEAM_API_KEY || null,
  },
  // Merge env vars with settings.battlemetrics (explicit key overrides spread above)
  battlemetrics: {
    ...settings.battlemetrics,
    token: process.env.BM_TOKEN || settings.battlemetrics?.token,
    serverId: process.env.BM_SERVER_ID || settings.battlemetrics?.serverId,
  },
});

export default config;
